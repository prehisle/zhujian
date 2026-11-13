import {
  type SpaceInfo,
  currentSpaceId,
  invoke,
  invokeInSpace,
  listSpaces,
  movePartialClear,
  movePartialNote,
} from "./space";
import { movePanel } from "./move-space";
import { autoGrow } from "./autogrow";
import { createComposeController } from "./compose-controller";
import { copyButton, copyFailText, copyText } from "./clipboard";
import { dismissUndo, flashToast, toastAction, toastError, toastGo, toastUndo, toastUndone } from "./toast";
import { buildItemDeepLink } from "./deeplink";
import { armLocate, clearSearchBack, locateNoteEl, takeLocateNote } from "./locate";
import { focusInboxItem } from "./inbox";
import {
  type FilterState,
  type TimeBucket,
  applyFilter,
  applyTimeFilter,
  autoTagTopicIds,
  filterActive,
  markFilterHits,
  paintFilterCount,
  reconcileKindFilter,
  reconcileTopicFilter,
  renderFilterPills,
  wireFilterFold,
  renderKindPills,
  renderTimePills,
  otherLayersNote,
  selectedTopicLabels,
  wireFilterInput,
} from "./filter-bar";
import {
  type BoardColumn,
  boardColumns,
  columnName,
  loadBoardColumns,
} from "./board-columns";
import {
  type Board,
  BOARDS_CHANGED,
  boardName,
  boardsChanged,
  currentBoard,
  doneColumnSet,
  holdingColumns,
  liveBoards,
  loadBoards,
  loadSealedCounts,
  markActiveBoard,
  moveTaskToBoard,
  shareBoardData,
  setCurrentBoard,
  setBoardViewLive,
  setDraggingCard,
} from "./boards";
import { closeColumnManager, openColumnManager } from "./column-manager";
import { closeHistoryDialog, openHistoryDialog } from "./history-panel";
import { BOARD_CARD_KEYS, BOARD_TRASH_KEYS, BOARD_VIEW_KEYS, SEALED_CARD_KEYS } from "./keymap";
import { type RemovedGroup, listRemovedImages, loadTrashCounts, removedImageCount, removedImagesSection } from "./trash-images";
import { trashPurgeControl } from "./trash-purge";
import { type Act, SATELLITE_LAYERS, armDismiss, createHotkeyController, noHistoryAct, registerViewKeys } from "./hotkey-menu";
import { CARD_COLORS, applyCardColor, openCardColorPicker } from "./card-color";
import { type ImageMeta, REPASTE_HINT, imageStrip, openLightbox, renderContent, wirePasteToAttach } from "./item-images";
import { toggleChecklistLine } from "../shared/checklist";
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
import { type TaskItem, DUE_SOON_DAYS, PRIORITY_LABEL, dayKey, dayLabel, dueAttentionState, dueDayText, itemSnippet, dueSummaryFullLabel, isDueSoon, localToday, metaRow, startOfWeek, when } from "./tasktime";
import { identitySig, loadIdentity, signatureChip } from "./identity";
import { t } from "./i18n";
import { FOLD_SLACK_PX, hasBoxBelowFold } from "./fold";
import { dropEmptyChecklistLines, wireChecklistInput } from "./checklist-input";
import "./board.css";
import { arrowWalk, el, holdKeyboard, onDragTarget, trapTab } from "./dom";
import { isTabKey } from "./keys";
import { errDetail, errText } from "./err";

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
// (0043 起是**每块看板自己的落点**,core 解析,`Board.landing`),此后随手拖。

// ---- 列内排序轴(500)--------------------------------------------------------
// 默认「手动」= 用户拖出来的 `position` 序,那是看板的本义;另两档按 `created_at` 正/逆序。
//
// ⛔ **刻意没有「更新时间」那一档**,虽然用户是那么问的:`items.updated_at` 是**本地簿记、
// 不同步** —— 回放收到远端 op 时写的是**本机 now**(`core/src/oplog.rs`),三端收敛测试明确
// 把它排除在指纹外(`core/src/replay.rs`「排除 items.updated_at——它是本地簿记,两端刻意
// 不同」)⇒ 按它排,两台设备顺序会不一样,而用户看到的会是「手机和电脑排得不一样」这种
// 说不清的毛病。`created_at` 是同步字段、恒有值、两端一致。要真做「更新时间」得先把它升成
// 同步字段(迁移 + 词汇 + 旧端归型)= 数据层红线,不是一次排序功能顺手能带的。
//
// 存 localStorage、**不进同步**(同 last-view / zoom / theme:这是「我这台屏幕怎么看」的
// 属性)。读不到 / 不认识的值一律回落 manual —— 这不是「静默兜底」,是「用户还没选过」。
export type BoardSort = "manual" | "newest" | "oldest";
const SORT_KEY = "zhujian.board-sort";
const SORT_CYCLE: BoardSort[] = ["manual", "newest", "oldest"];
let boardSort: BoardSort = readBoardSort();
function readBoardSort(): BoardSort {
  const raw = localStorage.getItem(SORT_KEY);
  return raw === "newest" || raw === "oldest" ? raw : "manual";
}
function sortLabel(s: BoardSort): string {
  return s === "newest" ? t("board.sortNewest") : s === "oldest" ? t("board.sortOldest") : t("board.sortManual");
}
/** 页头窄档里「顺序」那枚只剩的一个词(898 B1):状态字,中英都有 —— 此前窄档是无字的 ↕,看不出此刻哪一档。 */
function sortLabelShort(s: BoardSort): string {
  return s === "newest" ? t("board.sortNewestShort") : s === "oldest" ? t("board.sortOldestShort") : t("board.sortManualShort");
}
// 卡上的交互件(⋯ 钮 / 标签 chip 与它的 ✕ / 勾选框 / 留言徽章 / 「图N」链接 / 缩略图 /
// 行内确认的钮与勾选)。按下或双击落在它们上面,那一下归它们自己:不是拖卡、不是开编辑。
// ⚠ 认的是**缩略图本身**(`.img-thumb`),不是整条缩略图条:条是撑满卡宽的一行,图右边那截
// 空白就是纸面,此前写 `.img-strip` 把它也算成控件 ⇒ 有图的卡按在图旁空白处拖不动(用户 10-10 报)。
// ⚠ 这些件自己身上的 `draggable:false` **不是**保护 —— Blink 找拖源沿祖先往上走,子元素的
// draggable=false 只让它自己不成拖源、挡不住父卡(671 补在真 WebView2 上量的:按住 ⋯ 拖照样起
// 卡片拖,拖动数据 = 任务 id)。真正挡住的是下面 card() 里 mousedown 看落点那一段。
// W3 159 起多一块:移空间面板(`.move-panel`)整块归它自己 —— 在面板的字上按住拖不是拖卡、双击不是开编辑。
const CARD_CONTROLS = "a, button, input, textarea, label, .chip, .hk-menu-wrap, .img-thumb, .move-panel";

/** 一列之内按当前轴排。manual = 原样(后端已按 position 给);时间档按 `created_at`
 *  字符串比 —— RFC3339 同一形状下字典序 == 时序,同刻再按 id(ULID)定序,免得两张
 *  同秒建的卡每次重画都换位置。⚠ 不原地改数组:调用方那份 `items` 还要给别处用。 */
function sortColumn(items: TaskItem[], s: BoardSort): TaskItem[] {
  if (s === "manual") return items;
  // dir = 「早的排前面」时的符号。oldest 取 +1(早的返回负数 = 在前),newest 取 −1。
  const dir = s === "newest" ? -1 : 1;
  return [...items].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -dir : dir) : a.created_at < b.created_at ? -dir : dir,
  );
}

/** 「只看到期」(dueOnly)那一档的列内序:按截止日升序 —— 逾期最久的排最前,今天到期
 *  的排在逾期后面,快到期(60-A)的再往后,不再理会 boardSort(手动位置 / 创建时间对
 *  「哪个最火烧眉毛」这个问题答不上来)。⭐ 加了「快到期」这一档之后这句序**一个字没改**
 *  就还对:升序天然把「逾期 → 今天 → 后天」排成紧急度。dueOnly 下的卡必有 due_on
 *  (dueAttentionState 与 isDueSoon 都已把无截止日的排除),
 *  `?? ""` 只是不让类型检查为难,不代表真会撞上 null。同 sortColumn:不原地改数组。 */
/** 只读的标签胶囊(归档册,165 / W5 A44):样子同看板卡上那枚(`.chip.topic.set`,有色的着色),不带 ✕ —— 归档册改不动。 */
function readonlyTopicChip(tp: { title: string; color: string | null }): HTMLElement {
  const chip = el("span", { className: "chip topic set" }, [el("span", { className: "chip-label", textContent: tp.title })]);
  applyTagColor(chip, tp.color);
  return chip;
}

function sortByDue(items: TaskItem[]): TaskItem[] {
  return [...items].sort((a, b) => {
    if (a.due_on !== b.due_on) return (a.due_on ?? "") < (b.due_on ?? "") ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// ---- small DOM helper (same shape as inbox.ts) ------------------------------
const btn = (label: string, kind: string, onclick: () => void) =>
  el("button", { className: `act ${kind}`, textContent: label, onclick });

// ---- 一键复制为 Markdown ----------------------------------------------------
// One task → one bullet. A card in the 完成 column is a checked item, every other
// column unchecked (a Markdown task list has only those two marks — the column a card
// sits under is the状态). A multi-line title is collapsed to one line so it stays one bullet.
// 158 G2 / A14(W2 复核新撞 1):多行正文不再压成一行 —— 卡里的清单被压成「- [ ] 搬家打包 - [x] 书 - [ ] 衣服」、
// 空行也丢了。首行做这条任务的那一项,其余各行原样缩两格挂在它下面(Markdown 列表项的续行 / 子清单),
// 空行保留为空行(不带缩进,免得行尾挂空格)。
function mdLine(item: TaskItem, done: boolean): string {
  const box = done ? "[x]" : "[ ]";
  const lines = item.title.trim().split(/\r?\n/);
  const rest = lines.slice(1).map((l) => (l.trim() === "" ? "" : `  ${l.trimEnd()}`));
  return [`- ${box} ${lines[0].trim()}`, ...rest].join("\n");
}
// `done` = 这一列是它看板解析后的完成列(0043:读 core 给的角色,⛔ 别比 "done" 字面量)。
function columnMarkdown(name: string, done: boolean, items: TaskItem[]): string {
  return [`## ${name}`, ...items.map((t) => mdLine(t, done))].join("\n");
}
// The whole board: each non-empty column in board order, blank line between.
function boardMarkdown(cols: BoardColumn[], items: TaskItem[], doneId: string | null): string {
  return cols
    .map((c) => ({ name: columnName(c), done: c.id === doneId, inCol: items.filter((t) => t.status === c.id) }))
    .filter((c) => c.inCol.length > 0)
    .map((c) => columnMarkdown(c.name, c.done, c.inCol))
    .join("\n\n");
}

// 顶栏窄到「字母态」(board.css 那条 839 的 container query)时,到期 / 归档 / 回收站三枚此前只剩
// 「6」「3 G」「0 R」(158 G3 / Q13,WD-29)。字母态里给它们各留一枚小图标(全名照旧在 title 里),
// 平时藏着。线稿走 currentColor,明暗两档跟着字色走;⛔ 别换成 emoji(WebView2 会画成彩色)。
const ICON_DUE =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/></svg>';
const ICON_SEAL =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="3.5" rx="0.8"/><path d="M3 6v7.2h10V6M6.3 8.6h3.4"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.2h11M6.2 4.2V2.6h3.6v1.6M3.8 4.2l.8 9.2h6.8l.8-9.2"/></svg>';

// W4 A25(新撞-5):有了第一张任务才冒出来的几枚(到期汇总 / 顺序)排在「+ 新建卡片」**左边**——
// 页头这一组整体靠右,新冒出来的只吃掉左边的空当,「+ 新建任务」及右边几枚原地不动。此前它们排在右边,
// 记下第一张时整排往左挪约 100px,手正要再点「+ 新建任务」就点空了。
// 898 B1(页头收纳):此前一排七枚同样轻重。「+ 新建卡片」成了这一页唯一的实心主钮(与随记页「记下」同一档,
// `.hbtn.primary`),位置不动 —— 仍在后冒出来那两枚之右、「⋯ / 归档 / 回收站」之左:放最右的话进归档 / 回收站
// (它收起)那一下,「归档」「回收站」两枚开关会从手底下滑走;放到「到期汇总」紧后面则「顺序」冒出来时它要挪(A25)。
// 「复制看板」「管理看板」收进一枚「⋯」(`#board-more`,菜单是点开才建的 `.hk-menu`);「顺序」留在页头(它的
// 当前档决定卡能不能拖,得常显),窄了缩成「手动 / 最新 / 最早」一个词,⛔ 不再退成无字的 ↕。
const SKELETON = `
  <header data-tauri-drag-region>
    <h1>${t("board.title")}</h1>
    <span class="spacer" data-tauri-drag-region></span>
    <span class="head-tools">
      <button class="hbtn due-soon" id="due-soon" title="${t("board.dueSoonTitle", { days: DUE_SOON_DAYS })}" hidden><span class="lbl" id="due-soon-lbl"></span><span class="ico">${ICON_DUE}</span><span class="lbl-short" id="due-soon-n"></span></button>
      <button class="hbtn" id="board-sort" title="${t("board.sortTitle")}"><span class="lbl" id="board-sort-lbl">${t("board.sortManual")}</span><span class="lbl-short" id="board-sort-short">${t("board.sortManualShort")}</span></button>
      <button class="hbtn primary" id="add-task" type="button" title="${t("board.newTask")}">+ <span class="lbl">${t("board.newTask")}</span> <kbd class="k">N</kbd></button>
      <button class="hbtn" id="board-more" type="button" title="${t("board.moreTitle")}" aria-label="${t("board.moreTitle")}" aria-haspopup="menu" aria-expanded="false">⋯</button>
      <button class="hbtn" id="seal-toggle" title="${t("board.sealTitle")}"><span class="lbl">${t("board.sealLbl")}</span><span class="ico">${ICON_SEAL}</span><span class="tn" id="seal-n">0</span> <kbd class="k">G</kbd></button>
      <button class="hbtn" id="trash-toggle" title="${t("board.trashTitle")}"><span class="lbl">${t("board.trashLbl")}</span><span class="ico">${ICON_TRASH}</span><span class="tn" id="trash-n">0</span> <kbd class="k">R</kbd></button>
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
      <span class="filter-count" id="board-filter-count" hidden></span>
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

// Three views in one column: the kanban, the 回收站 (soft-deleted tasks), and the
// 归档 (成就归档 — sealed done tasks, viewable, not deletable).
// 0043 多一格 `holding`:收容区(已删除的看板 / 列里还扣着的卡,multiboard-plan §3a),从侧栏底部那行进。
type BoardView = "board" | "trash" | "sealed" | "holding";

// The 标签/文本 filter must survive leaving and returning to the board. navigate() in
// notebook.ts unmounts+remounts on every view switch, so a mount-scope value would
// reset the selection to 所有 each time you switch away and back (and on Ctrl+Alt+M).
// Module scope keeps it (same rationale as topics.ts's `expanded`); only one board is
// mounted at a time, so a single shared value is correct. The 回收站 toggle (boardView)
// stays mount-scope on purpose — it's a transient peek, so a fresh mount lands on the
// board, not the trash. 行为(pills/口径/Esc)在共享件 filter-bar.ts,与灵感同源。
//
// 时间轴(461):与 filter 同款模块态存活理由(跨 mount/切视图保住选择)。与 kind/
// topics/text 三维正交,单独一格状态——不塞进 FilterState,免得 check-filter-parity
// 的逐字一致门禁把它当成两端必须同步的一部分(那道闸只钉 FilterState 里已有的三维)。
//
// ⭐ W3 159 / Q6(WD-18):两样都**按空间各记一份**(同随记 inbox.ts 的 SpaceMemo):此前全模块一份,切到别的空间
// 那边没有这枚标签 ⇒ reconcileTopicFilter 把选集清空,切回来筛选没了。mount 时按本 mount 的空间取、unmount 写回。
//
// ⭐ R5(多看板优化,用户 2026-11-12 拍):**切到另一块看板时标签 / 类型 / 时间筛选回「所有」**(别的看板多半没有这几枚
// 标签,留着只会把新那块筛空)。`board` = 这份筛选是在哪块看板上选的;load() 发现眼前这块不是它就清。过滤词不清
// (它不认看板,打的字跟着人走)。⚠ 判据放在 load() 而不是各个「切看板」入口:切的路有侧栏、新建、「去看看」、
// 跳转、所在那块被删回默认 …… 漏一条就是一次筛空。
type SpaceMemo = { filter: FilterState; time: TimeBucket; board: string | null };
const memos = new Map<string, SpaceMemo>();
function memoFor(space: string): SpaceMemo {
  let m = memos.get(space);
  if (m === undefined) {
    m = { filter: { kind: "all", topics: [], text: "" }, time: "all", board: null };
    memos.set(space, m);
  }
  return m;
}

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
// ⛔ `why`(538,用户面 56)说得准就**替掉** REPASTE_HINT,不是并列:不支持的格式 /
// 过大都是确定性拒法,「再贴一次」注定还是失败;说不准(`""`)才退回原来那句泛指引。
function partialImgMsg(failed: number, why: string): string {
  return t("board.partialImg", { n: failed }) + (why || REPASTE_HINT);
}

// 一次保存里两类部分失败的合并文案:图没附上(上面那句)+ 标签没挂上(「筛着标签建卡」
// 把被筛的几枚全挂上,补挂那几枚可能个别失败)。两样都没有 = 空串,顺带清掉上一条提示。
// 拼接符同灵感侧 notices 的形。
function partialSaveMsg(imgFailed: number, why: string, tagFailed: number): string {
  const parts: string[] = [];
  if (imgFailed > 0) parts.push(partialImgMsg(imgFailed, why));
  if (tagFailed > 0) parts.push(t("board.partialTag", { n: tagFailed }));
  return parts.join(";");
}

export function mount(root: HTMLElement, ctx: ViewCtx): View {
  // 本 mount 归属的空间:切空间时 notebook 先翻 current 再 unmount,unmount 时现取会
  // 把 A 空间的草稿标成 B 的——必须在这里捕获(codex P1 审 H1)。
  const mountSpace = currentSpaceId();
  // Q6:这个空间自己的那份筛选(filter 同一对象,筛选条直接改它;timeFilter 在 unmount 时写回)。
  const memo = memoFor(mountSpace);
  const filter = memo.filter;
  let timeFilter = memo.time;
  const view = el("div", { className: "v-board view" });
  view.innerHTML = SKELETON;
  root.replaceChildren(view);

  const board = view.querySelector("#board") as HTMLElement;
  const boardTitle = view.querySelector("header h1") as HTMLElement;
  const filterRow = view.querySelector("#filter-row") as HTMLElement;
  const filterBar = view.querySelector("#topic-filter") as HTMLElement;
  const offFilterFold = wireFilterFold(filterBar, "board", view); // 标签行两行折叠(902 F5)
  const kindBar = view.querySelector("#kind-filter") as HTMLElement;
  const timeBar = view.querySelector("#time-filter") as HTMLElement;
  const filterInput = view.querySelector("#board-filter") as HTMLInputElement;
  const filterCount = view.querySelector("#board-filter-count") as HTMLElement;
  const trashToggle = view.querySelector("#trash-toggle") as HTMLButtonElement;
  const trashN = view.querySelector("#trash-n") as HTMLElement;
  const sealToggle = view.querySelector("#seal-toggle") as HTMLButtonElement;
  const sealN = view.querySelector("#seal-n") as HTMLElement;
  const addTaskBtn = view.querySelector("#add-task") as HTMLButtonElement;
  const sortBtn = view.querySelector("#board-sort") as HTMLButtonElement;
  const sortLbl = view.querySelector("#board-sort-lbl") as HTMLElement;
  const sortShort = view.querySelector("#board-sort-short") as HTMLElement;
  const dueSoonBtn = view.querySelector("#due-soon") as HTMLButtonElement;
  const dueSoonLbl = view.querySelector("#due-soon-lbl") as HTMLElement;
  const dueSoonN = view.querySelector("#due-soon-n") as HTMLElement;
  const moreBtn = view.querySelector("#board-more") as HTMLButtonElement;
  const compose = view.querySelector("#compose") as HTMLElement;
  const composeInput = view.querySelector("#compose-input") as HTMLTextAreaElement;
  wireChecklistInput(composeInput); // Shift+Enter 续待办项 / Ctrl+L 起一条 / Tab 缩进(562,600)
  const composeAdd = view.querySelector("#compose-add") as HTMLButtonElement;
  const composeClose = view.querySelector("#compose-close") as HTMLButtonElement;
  const composeErr = view.querySelector("#compose-err") as HTMLElement;
  const opErrBar = view.querySelector("#op-err") as HTMLElement;
  const opErrMsg = view.querySelector("#op-err-msg") as HTMLElement;

  // D11:页头那几格变了才写 —— 原样再写一遍也算一次 DOM 变更,会惊动页头的 MutationObserver 白量一趟。
  const setText = (n: Node, s: string): void => {
    if (n.textContent !== s) n.textContent = s;
  };
  const setHidden = (e: HTMLElement, h: boolean): void => {
    if (e.hidden !== h) e.hidden = h;
  };

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

  // ---- 到期汇总(502)---------------------------------------------------------
  // 「截止时间提醒」的**最小可用形**:不加通知插件、不动数据模型,只把已经在库里的
  // `due_on` 汇总到顶栏 —— 「逾期 M · 今天 N」,点一下把看板收成只剩这些卡。
  // ⛔ 这不是「提醒」:应用没开它不会说话。真正的系统通知要么加插件(桌面)、要么后台
  //    闹钟 + 权限(安卓),而且 `due_on` 今天只有**日**没有时刻 —— 那是另一笔账。
  // ⚠ 显示条件 = 有内容:一条到期/逾期都没有时整枚藏起(别在顶栏摆一个恒亮的 0)。
  let dueOnly = false; // mount 级(同 boardView 的 peek 语义,不跨视图记忆)
  // 归档册的看板筛选(0043,用户拍 ⑦;null = 全部)。同 dueOnly 是 mount 级的 peek,不跨视图记。
  let sealedBoard: string | null = null;
  // 归档卡要不要挂来源看板的小签(= 顶上那排筛选在不在);renderSealed 每次先算好再画卡。
  let sealedTagged = false;
  // 这一趟归档册是从收容区(「已删除的看板 / 列」)进来的 ⇒ 没有「当前看板」:筛选排里不硬塞一枚、进来选「全部看板」(902 F8)。
  let sealedNoHome = false;
  /** 这一趟挂着看板以来,活卡上出现过标签的看板(标签行恒占位的判据,见 load 里 B8 / W3 那段)。 */
  const tagRowBoards = new Set<string>();
  /** 跨过本地午夜自动重算一次:`today` 只在 load() 里刷新,而「今天到期」这件事**没人
   *  操作也会变**。算到下一个本地零点的毫秒数,到点重画并再排一次。unmount 清。 */
  let midnightTimer: ReturnType<typeof setTimeout> | undefined;
  function armMidnightRefresh(): void {
    clearTimeout(midnightTimer);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5).getTime();
    midnightTimer = setTimeout(() => {
      if (unmounted) return;
      void load();
      armMidnightRefresh();
    }, Math.max(1000, next - now.getTime()));
  }

  // topicFilter is module-scope (survives view switches); allTopics feeds the filter
  // bar and the per-card picker, rebuilt each load.
  let allTopics: TopicOpt[] = [];

  // 本看板要画的列(= 这块看板的活任务列,判据在 board-columns.ts `boardColumns`;删掉的列里还扣着的卡
  // 0043 起进收容区,不再画在原看板上),每次 load 重取。
  // ⚠ **mount 级,不是模块级**:切空间 = 换一整套列,模块级会把 A 空间的列画到 B 上
  // (memory `module-state-hoisting-checklist` 那五坑的第一条)。首帧空数组 —— load()
  // 之前没有任何渲染路径读它。
  let cols: BoardColumn[] = [];
  // 0043 多看板(multiboard-plan §6):全部列(命名回收站 / 归档 / 收容区里的来处要它)、全部看板、
  // 这台此刻在看的那块(`boards.ts` currentBoard:记着的那块还活着就是它,否则默认看板)。
  // ⭐ 角色(落点 / 完成列)只读 core 解析的 `cur.landing` / `cur.done`,⛔ 前端不另算。
  // 同 cols:mount 级、首帧空,load() 之前没有渲染路径读它们。
  let allCols: BoardColumn[] = [];
  let boards: Board[] = [];
  let cur: Board | null = null;
  /** 本看板解析后的完成列(null = 纯分类看板:没有「完成」、没有归档入口)。 */
  const doneId = (): string | null => cur?.done ?? null;
  /** 本看板解析后的落点(null = 放不进卡;core 会响亮拒)。 */
  const landingId = (): string | null => cur?.landing ?? null;
  /** 全部看板的完成列(到期口径「完成的不算」按它)。 */
  let doneCols = new Set<string>();
  /** 一列的显示名(含别的看板的列 / 已删的列);找不到 = null。 */
  const anyColName = (id: string): string | null => {
    const c = allCols.find((x) => x.id === id && x.kind === "task");
    return c ? columnName(c) : null;
  };
  /** 卡回到这一列 = 进收容区吗(core 的 `held`:列已删 ∨ 看板已删;不看此刻有没有卡)。 */
  const heldAt = (id: string): boolean => allCols.some((c) => c.id === id && c.held);
  /** 一列属于哪块看板(找不到 = null)。 */
  const boardOfCol = (id: string): Board | null => {
    const c = allCols.find((x) => x.id === id && x.kind === "task");
    return c?.board_id ? (boards.find((b) => b.id === c.board_id) ?? null) : null;
  };
  /** 「挪到看板 ▸」的候选:别的活看板里放得进卡的那几块(落点 ⊥ 的不列 —— 显示条件 = 接收条件)。
   *  `includeOwn` = 收容区里的卡:它自己那块看板(还活着时)也是合法出口(core move_to_board 头注)。 */
  function moveBoardTargets(item: TaskItem, includeOwn = false): Board[] {
    const own = boardOfCol(item.status)?.id ?? null;
    return liveBoards(boards).filter((b) => b.landing !== null && (includeOwn || b.id !== own));
  }

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
    holdTypeAhead();
    void load();
  }
  // 按 E 到编辑框出现之间隔着一次 load() 重画:这段里那张卡还不算「编辑中」,紧跟着打的字会被当成
  // 它的单键派发(D 删 / T 置顶 / S 截止……),要不就落空(168)。⇒ 待开编辑期间把可打印的单键收进
  // 缓冲、不派发,编辑框一出来照原样续在光标处(openEdit 末尾);Esc 当场撤掉这次开编辑、Backspace
  // 删缓冲末字。兜底 1 秒自放:卡没画出来(被远端删了)时别一直吞键。
  // ⚠ 输入法:没有可编辑的焦点时输入法不组字,缓冲里收到的是拼音字母本身 —— 续进框里也是字母,
  // 窗口之后的键才进输入法(知情的边界;不收的话那几个字母要么落空、要么被当成单键)。
  let typeAhead: { buf: string; release: () => void } | null = null;
  function holdTypeAhead(): void {
    if (typeAhead) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.key === "Escape") {
        pendingEditId = null;
        release();
      } else if (e.key === "Backspace") {
        if (typeAhead) typeAhead.buf = [...typeAhead.buf].slice(0, -1).join("");
      } else if ([...e.key].length === 1) {
        if (typeAhead && !e.repeat) typeAhead.buf += e.key;
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const timer = setTimeout(() => release(), 1000);
    function release(): void {
      document.removeEventListener("keydown", onKey, true);
      clearTimeout(timer);
      typeAhead = null;
    }
    document.addEventListener("keydown", onKey, true);
    typeAhead = { buf: "", release };
  }
  /** 取走待开编辑期间收下的字并放手(没在收 = 空串)。 */
  function takeTypeAhead(): string {
    const s = typeAhead?.buf ?? "";
    typeAhead?.release();
    return s;
  }

  // Whether a topic filter is active. When filtered the column DOM holds only the
  // VISIBLE subset, so a drop goes through reorder_task_visible (which merges the
  // visible reorder back into the full column server-side) instead of the unfiltered
  // strong-contract reorder_task. Set per load().
  let filtered = false;
  // 「已完成」列此刻的**全部**卡(不随筛选收窄)—— 全部归档的问句计数与撤销名单(158 G2 / A6)。每次 load 重写。
  let doneIds: string[] = [];

  // Serialize drag mutations: ignore a new drag/drop while one is still in flight
  // (a rapid second drop could otherwise build its order from a pre-refresh DOM and
  // silently clobber the first). Cleared once the reload after the mutation lands.
  let busy = false;

  // 悬停选中 + ⋯ 速查菜单 + 单键派发(与灵感共用同一控制器、键义一致)。每次 load() 重渲
  // 前 reset(),卸载时 destroy()。
  // W5 Q10 ★①:看板的 ← → 换列(选中跳到隔壁列最上面那张,空列跳过);Tab 顺序不动。
  const hk = createHotkeyController({ lane: (c) => c.closest<HTMLElement>(".col") });

  // 可移入的其他空间(cross-space-move v1):挂载时取一次——空间集变化必经
  // notebook 空间菜单(切换/新建)→ 视图重挂即重取。空 = 单空间,「移动」不出现。
  let otherSpaces: SpaceInfo[] = [];
  void listSpaces()
    .then((all) => {
      otherSpaces = all.filter((sp) => sp.alive && sp.id !== currentSpaceId());
    })
    .catch(() => {});

  // ---- mutations: call the backend, then reflect the new truth by reloading --
  async function call(cmd: string, args: Record<string, unknown>): Promise<boolean> {
    clearOpError();
    try {
      await invoke(cmd, args);
    } catch (err) {
      // The task may have moved under us (stale view) — surface, don't swallow.
      // 横幅就地报错 + 重载对齐真相,绝不把整个看板换成错误页(ui-audit P0 #6)。
      showOpError(errText(err));
      load();
      return false;
    }
    load();
    return true;
  }

  // 716:删除 / 归档 / 移列 / 数字键换色配发「回执 + 撤销」(§3.1 操作型;这几枚单键悬停即
  // 生效,此前卡片无声离场)。撤销 = 反向命令走同一条 call(失败横幅报错 + 重载);mount 死了
  // (切了视图 / 空间)按下作废 —— invoke 注入的是当前空间。
  // `extra` = 撤销旁边的第二枚钮(Q1 的「去看看」/ 撤回为随记的「去看看」)。
  // 165 / W5 Q6 ★①:`undo` 回「撤成没有」—— 撤成了说一声「已撤销」(两端同句);撤不成的那支各自已报错(横幅),不说。
  function undoable(ok: boolean, text: string, undo: () => Promise<boolean>, extra?: { label: string; run: () => void }): void {
    if (!ok || unmounted) return;
    toastUndo(
      text,
      t("common.undo"),
      () => {
        if (unmounted) return;
        void undo().then((done) => {
          if (done && !unmounted) toastUndone();
        });
      },
      extra && {
        label: extra.label,
        run: () => {
          if (!unmounted) extra.run();
        },
      },
    );
  }

  // ---- Q1「去看看」(158 G3,WD-16)--------------------------------------------------------
  // 挪完 / 新建完,卡的落点不变(挪到列尾、新卡排列首),但落点可能在列的可视区外 —— 长列里按 `]`
  // 挪过去的卡落在第 38 张、列滚到底时新建的卡排在最上面,屏上「什么也没发生」。⇒ 落点在视野外时
  // 回执多挂一枚「去看看」:点了把卡滚进视野中央、闪一下。在视野里就不挂(看得见的不必指路)。
  /** 这张卡此刻在不在它那一列(与整排列)的可视区里。找不到(被筛掉 / 已离场)= 不算「在视野外」。 */
  function cardOffscreen(id: string): boolean {
    const c = board.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
    const body = c?.closest<HTMLElement>(".col-body");
    const wrap = board.querySelector<HTMLElement>(".cols");
    if (!c || !body || !wrap) return false;
    const r = c.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return r.bottom <= b.top + 4 || r.top >= b.bottom - 4 || r.right <= w.left + 4 || r.left >= w.right - 4;
  }
  /** 把卡滚进视野中央并闪一下(复用新建那记朱砂涟漪 .just-born)。 */
  function flashCard(id: string): void {
    const c = board.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
    if (!c) return;
    c.scrollIntoView({ block: "center", inline: "nearest" });
    c.classList.remove("just-born");
    void c.offsetWidth; // 摘了再挂:让同一张卡上的动画重新起跑
    c.classList.add("just-born");
    const onEnd = (e: AnimationEvent): void => {
      if (e.animationName !== "born-pulse") return;
      c.classList.remove("just-born");
      c.removeEventListener("animationend", onEnd);
    };
    c.addEventListener("animationend", onEnd);
  }
  /** 落点在视野外才给的「去看看」钮;在视野里给 undefined。 */
  function goSeeIfHidden(id: string): { label: string; run: () => void } | undefined {
    return cardOffscreen(id) ? { label: t("inbox.goSee"), run: () => flashCard(id) } : undefined;
  }

  // 删卡片不再先问(902 F4 / R3,用户拍板;两端同形):直接进回收站 + 带「撤销」的回执,同删随记。此前(158 G3 / Q6)
  // 是行内确认 +「不再提示」勾选 + 设置里那枚「删卡片前确认」开关,三样一并拿掉;旧的本地存储键留在用户机器上不管。
  // ⛔ 别的两拍确认(清空回收站 / 销毁 / 全部归档 / 删列 / 删看板…)不在此列。菜单与单键 D 走的都是这一条;
  // 删后选中 / 焦点落原位后一张(重画接力,hotkey-menu 的 RegisterOpts.id,W5 A3)。
  const archive = async (id: string): Promise<void> => {
    undoable(await call("archive_task", { id }), t("board.undoDeleted"), () => {
      hk.want(id, true); // 撤回来的那张重新是选中、焦点回它的 ⋯(同删随记的撤销,W5 A1)
      return restore(id);
    });
  };
  // 158 G2 / A7(WD-06 / 36):撤回为随记此前一声不吭。回执带「去看看」(随记页定位那条)。
  // 158 G3 / A7 对齐手机(74fe6f65):再配「撤销」= 转回待办,并把撤回时清掉的截止 / 优先级原样设回 ——
  // 取值冻结在点「撤回」那一刻;设不回就不是完整的撤销(§3.1「撤销 ≠ 完整恢复不配发」)。
  // 0043:撤销要转回**原来那块**看板,⛔ 不是默认看板 —— 否则在非默认看板上撤回再撤销,卡会跑到另一块上去。
  // 只有落点列里的卡撤得回,所以「回原列」= 那块看板的落点**仍是撤回前那一列**;落在列首(列内位置本就不还原,
  // 158 起如此)。落点在撤回与撤销之间被改了(别的设备同步过来)⇒ 回不了原列 ⇒ core 在写事务里比 `expectedColumn`
  // 拒、什么都不写,⛔ 别落到新落点还说「已撤销」(codex 实现审 883 一、二轮 M1;前端先读再发隔一次往返,不原子)。
  const revert = async (item: TaskItem): Promise<void> => {
    const { id, title, due_on: due, priority: prio, status: was } = item;
    const home = boardOfCol(was);
    if (!home) throw new Error(`task ${id} is on column ${was}, which has no board`);
    if (!(await call("revert_task_to_inbox", { id })) || unmounted) return;
    undoable(
      true,
      t("board.reverted"),
      async () => {
        clearOpError();
        try {
          await invoke("promote_note_to_task", { id, title, boardId: home.id, expectedColumn: was });
          if (due !== null) await invoke("set_task_due", { id, dueOn: due });
          if (prio !== null) await invoke("set_task_priority", { id, priority: prio });
        } catch (e) {
          showOpError(errText(e)); // 多半是别处已动过它(删了 / 又改了):照实报,不猜
          void load();
          return false;
        }
        void load();
        return true;
      },
      {
        label: t("inbox.goSee"),
        run: () => {
          focusInboxItem(id, "ideas");
          ctx.navigate("inbox");
        },
      },
    );
  };
  const restore = (id: string) => call("restore_task", { id });
  // W3 159 / A7(WD-06 / WD-11):回收站里的三个动作做完都说一声。还原说回了哪一列、带「去看看」——
  // 此前卡默默消失,而它回到的那一列可能很长(实测排在待办第 38 / 38 张、在屏外)。点了 = 回看板并定位
  // 那张卡(复用跨视图跳转那条 focusId 通道:清筛选、滚到中央、常亮)。
  const restoreFromTrash = async (item: TaskItem): Promise<void> => {
    if (!(await call("restore_task", { id: item.id })) || unmounted) return;
    // 0043:回原列,原列可能在别的看板上 ⇒ 名字从全部列里取,「去看看」先切到那块看板。
    // 原列 / 原看板已删 ⇒ 卡进了收容区(plan §3a),「去看看」落收容区。
    const name = anyColName(item.status);
    const home = boardOfCol(item.status);
    const held = !home || heldAt(item.status);
    toastGo(
      held ? t("boards.restoredHeld") : name !== null ? t("trash.restoredTask", { col: name }) : t("trash.restoredBoard"),
      t("inbox.goSee"),
      () => {
        if (unmounted) return;
        focusId = item.id;
        if (held) boardView = "holding";
        else {
          if (home) setCurrentBoard(home.id, mountSpace);
          boardView = "board";
        }
        void load();
      },
    );
  };
  // 165 / W5 Q15:找不回的那一下写出删的是哪一条(「已彻底删除「…」」,两端同句;整条没字照旧那句)。
  const purgeOne = async (item: TaskItem): Promise<void> => {
    if (!(await call("purge_task", { id: item.id }))) return;
    const name = itemSnippet(item.title);
    toastAction(name === "" ? t("trash.purged") : t("trash.purgedNamed", { name }));
  };
  const purgeAll = async (): Promise<void> => {
    if (await call("purge_archived_tasks", {})) toastAction(t("trash.emptied"));
  };
  // 成就归档(sealed 轴,与回收站分开):归档=干完的活入册,可查、不可删;取消归档回
  // 「已完成」列尾。删除归档条目没有直接入口——先取消归档回看板,再走正常两段式。
  const sealOne = async (id: string): Promise<void> => {
    // 撤销走裸 call:撤销本身不再配一条「已取消归档」回执(否则撤完又冒一条带撤销的,来回套娃)。
    undoable(await call("seal_task", { id }), t("board.undoSealed"), () => call("unseal_task", { id }));
  };
  // 158 G2 / A6(WD-07 / 08):全部归档与取消归档此前都不说话。全部归档的撤销 = 把这一批逐条取消
  // 归档(`ids` = 点下那刻看板上「已完成」列**全部**的卡,含被筛掉的 —— seal_done_tasks 归的就是全部)。
  const sealAllDone = async (ids: string[]): Promise<void> => {
    // 0043:按看板归档(这块看板解析后的完成列);纯分类看板根本不给这个入口。
    undoable(await call("seal_done_tasks", { boardId: cur?.id }), t("board.undoSealedAll", { n: ids.length }), async () => {
      let failed = 0;
      for (const id of ids) {
        try {
          await invoke("unseal_task", { id });
        } catch (e) {
          failed++;
          showOpError(errText(e)); // 逐条撤:撤不回的那条照实报(多半是别处已动过它),其余照撤
        }
      }
      void load();
      return failed === 0; // 有一条没撤回就不说「已撤销」(横幅里照实写着哪条)
    });
  };
  // 0043:取消归档**回原列**(core 不改语义,plan §4);原列 / 原看板已删 ⇒ 进收容区(§3a)。
  // 回执说回了哪一列;「去看看」切到那块看板(或收容区)再定位。
  const unseal = async (item: TaskItem): Promise<void> => {
    const id = item.id;
    const home = boardOfCol(item.status);
    const name = anyColName(item.status);
    const held = !home || name === null || heldAt(item.status);
    // 158 G3 / Q3:回执再带「去看看」—— 取消归档发生在归档页,卡回了看板,人还在归档页。
    // 点了 = 切回看板并定位那张卡(复用跨视图跳转那条 focusId 通道:清筛选、滚到中央、常亮)。
    undoable(
      await call("unseal_task", { id }),
      held ? t("boards.unsealedHeld") : t("board.undoUnsealed", { col: name }),
      () => call("seal_task", { id }),
      {
        label: t("inbox.goSee"),
        run: () => {
          focusId = id;
          if (held) boardView = "holding";
          else {
            if (home) setCurrentBoard(home.id, mountSpace);
            boardView = "board";
          }
          void load();
        },
      },
    );
  };
  // 跨看板挪(用户拍 ⑥):落对方落点列首;收容区里的卡也走这条出来。回执带「去看看」= 切过去定位。
  // ⛔ 不配撤销:挪回来落的是**这边的落点列首**,不是原位 —— 撤不成原样就不说「撤销」(§3.1)。
  const moveToBoard = async (item: TaskItem, target: Board): Promise<void> => {
    clearOpError();
    try {
      await moveTaskToBoard(item.id, target.id);
    } catch (e) {
      showOpError(errText(e));
      void load();
      return;
    }
    boardsChanged(); // 本视图听着这一声重取(onBoardsChanged),⛔ 别再自己 load 一遍(D10)
    if (unmounted) return;
    toastGo(t("boards.movedTo", { board: boardName(target) }), t("inbox.goSee"), () => {
      if (unmounted) return;
      setCurrentBoard(target.id, mountSpace);
      focusId = item.id;
      boardView = "board";
      void load();
    });
  };

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
      onDragTarget(pill, (e) => {
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

  // ---- 拖拽期的边缘自动滚动 ---------------------------------------------------
  // 原生 HTML5 DnD **不会**替我们滚内层滚动容器(`.col-body` 是 overflow-y:auto)⇒ 长列里
  // 「把最下面那张卡拖到最上面」根本做不到:拖到列顶边缘,列一动不动。这里自己接:指针进
  // 上下(列体)/ 左右(`.cols`,自定义列多到要横滚时)EDGE 像素带内就逐帧推滚动位,越贴边
  // 越快。
  //
  // ⚠ 两条真踩过的边界:
  //  · **指针不动时 dragover 不再触发** ⇒ 滚完必须拿上一次的 clientY 重跑 placeDropLine,
  //    否则插入线钉在滚动前那个槽上(松手就落错位置)。
  //  · 循环的活性只绑 `dragging`:drop / dragend / unmount 三处都把它清成 null,rAF 自然收尾;
  //    ⛔ 别再另设一个「该不该滚」的布尔,那就是两个真相源。
  const AUTOSCROLL_EDGE = 48; // 触发带宽度(px)
  const AUTOSCROLL_MAX_V = 18; // 贴边时每帧位移(px)
  let scrollRaf: number | null = null;
  let scrollPtrX = 0;
  let scrollPtrY = 0;
  let scrollBody: HTMLElement | null = null;

  /** 一根轴上的每帧位移:`near`/`far` = 指针到起始边 / 终止边的距离,带内线性加速,带外 0。 */
  function edgeVelocity(near: number, far: number): number {
    if (near < AUTOSCROLL_EDGE) return -AUTOSCROLL_MAX_V * (1 - Math.max(near, 0) / AUTOSCROLL_EDGE);
    if (far < AUTOSCROLL_EDGE) return AUTOSCROLL_MAX_V * (1 - Math.max(far, 0) / AUTOSCROLL_EDGE);
    return 0;
  }

  function autoScrollTick(): void {
    scrollRaf = null;
    if (!dragging) return; // 手势结束(drop/dragend/unmount 已清)——不续帧
    const body = scrollBody;
    if (body?.isConnected) {
      const r = body.getBoundingClientRect();
      const v = edgeVelocity(scrollPtrY - r.top, r.bottom - scrollPtrY);
      if (v !== 0) {
        const before = body.scrollTop;
        body.scrollTop = before + v;
        if (body.scrollTop !== before) placeDropLine(body, scrollPtrY); // 指针没动也要重算落点
      }
    }
    const wrap = board.querySelector<HTMLElement>(".cols");
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      const v = edgeVelocity(scrollPtrX - r.left, r.right - scrollPtrX);
      if (v !== 0) wrap.scrollLeft += v;
    }
    scrollRaf = requestAnimationFrame(autoScrollTick);
  }

  /** 每次 dragover 报一次指针位置与所在列体;循环没跑就起一趟。 */
  function pumpAutoScroll(body: HTMLElement | null, e: DragEvent): void {
    scrollBody = body;
    scrollPtrX = e.clientX;
    scrollPtrY = e.clientY;
    if (scrollRaf === null) scrollRaf = requestAnimationFrame(autoScrollTick);
  }

  function stopAutoScroll(): void {
    if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
    scrollRaf = null;
    scrollBody = null;
  }

  // Persist an UNFILTERED drag-reorder (within a column, or across columns inserting
  // at a spot). `baseIds` is the target column's full order BEFORE the move (stale-view
  // check), `orderedIds` its complete order after. The backend validates + writes
  // atomically. `busy` serializes against a second drop landing mid-flight.
  // 返回是否真落了账(716:移列的撤销回执只在落账后配发;拖放那条路不看返回值)。
  async function reorder(
    id: string,
    from: string,
    to: string,
    baseIds: string[],
    orderedIds: string[],
  ): Promise<boolean> {
    if (busy) return false;
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
      return true;
    } catch (err) {
      showOpError(errText(err)); // 拖拽失败横幅报错 + 重载对齐(ui-audit P0 #6)
      await load();
      return false;
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
  ): Promise<boolean> {
    if (busy) return false;
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
      return true;
    } catch (err) {
      showOpError(errText(err));
      await load();
      return false;
    } finally {
      busy = false;
    }
  }

  // ---- 新建任务 compose ------------------------------------------------------
  // The textarea auto-grows to fit its content (titles may span lines now) via the
  // shared autogrow.ts. ⚠ 只有 compose 这个框还封着顶(160px);编辑态那个 568 起**刻意
  // 无上限**(长正文一编辑就冒内滚动条,用户点名),别照这句去读 `.edit-input`。
  // Reset to one row when cleared.

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
  // 摊开着的长卡(704)。⭐ **mount 级就是它该活的长度**:load() 的全量重画在同一个 mount
  // 里,展开过的卡不会自己合上;切视图 / 重启即收回。⛔ 不进库、不进 localStorage、不进
  // 同步 —— 展开是「读一眼」的手势不是模式(同 boardView 那个 transient peek),存起来就是
  // 给每张卡各生一份要清理、且跨端语义还得重新定义的状态。
  const expanded = new Set<string>();
  // 本次保存里补挂失败的标签枚数(「筛着标签建卡」把被筛的几枚全挂上,头一枚随 create_task
  // 原子落库、其余补挂)。afterCreate 每次保存重写它,onSaved / onDeadMount 两个落点读它
  // 拼提示。单值够用:模块级 in-flight 闸保证同时只有一笔保存在飞。
  let tagFailed = 0;

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
        // 158 G2 / A16(WD-30):空着提交也说一声,别静默吞掉。
        composeErr.textContent = composeCtl.imgs.count() > 0 ? t("board.titleBeforeImages") : t("board.titleEmpty");
        return null;
      }
      // 筛着标签建卡 → 被筛的那几枚**全挂上**(用户 2026-08-31 拍板「相关的标签都打上才
      // 符合直觉」;此前只有单选那一枚归上去,多标签刻意不猜、改清筛选)。头一枚仍原子随
      // create_task 携带(与灵感的二次挂载是刻意分歧:任务归属是载荷的一部分,非法 topic
      // 让整行建不成、不留残骸),其余几枚走 afterCreate 补挂 —— 命令面按 stage 分家,
      // 任务侧是 add_task_topic。这里取 = 提交那刻冻结。
      const ids = autoTagTopicIds(filter);
      const topicId = ids[0] ?? null;
      // 0043:建在**这块**看板的落点(core 解析一次、贯穿插入 / 置顶 / 闸;落点 ⊥ 响亮拒,⛔ 不退别的看板)。
      return { payload: { title: submitted, topicId, boardId: cur?.id ?? null }, tagged: topicId === null ? 0 : 1, autoTags: ids.slice(1) };
    },
    afterCreate: async (id, _notices, autoTags) => {
      // 头一枚之外的补挂(串行:同一行的几笔标签写,并发只是自找写锁竞争,枚数是个位数)。
      // ⛔ 走 invokeInSpace(mountSpace) 而非裸 invoke:整条保存链都拿 mount 顶部捕获的
      // 空间对照,补挂也不许在切空间的窗口里落进别人的库。
      // 部分成功照登记:挂上几枚算几枚,失败数记在 tagFailed 上——任务已建,不回滚也不吞掉。
      // ⛔ notices 这条路看板不接(它不传 onSettled,骨架会把 notices 丢掉);提示走
      //    composeErr / op-err 横幅两个落点,与图部分失败同一条(见 onSaved / onDeadMount)。
      let ok = 0;
      for (const topicId of autoTags) {
        try {
          await invokeInSpace(mountSpace, "add_task_topic", { id, topicId });
          ok++;
        } catch {
          /* 逐枚计数,循环末统一记账;失败不中断其余几枚 */
        }
      }
      tagFailed = autoTags.length - ok; // 每次保存都重写(autoTags 空时归零),不累计
      return ok;
    },
    showErr: (el, msg) => {
      el.textContent = msg;
    },
    onDeadMount: (failed, why) => {
      // 部分失败先记账(活的看板 mount 用 op-err 横幅当场亮出来;不在场就过桥给
      // 下一个 mount)。图与标签两类部分失败同一个落点。
      if ((failed > 0 || tagFailed > 0) && currentSpaceId() === mountSpace) {
        const msg = partialSaveMsg(failed, why, tagFailed);
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
    onSaved: (id, tagged, failed, why) => {
      // 文本过滤下新建:新卡多半不含过滤词,会被当场滤到隐身——清掉过滤让它可见。
      if (filter.text !== "") {
        filter.text = "";
        filterInput.value = "";
      }
      // 标签维:挂上了任一枚 ⇒ 新卡在 OR 并集下必然入选,筛选**原样留着**(用户要的正是
      // 「在这个标签下建的任务留在这个标签下」)。一枚也没挂上(压根没筛具体标签,或几枚
      // 全挂失败)而又筛着具体标签 ⇒ 会隐身,清掉标签筛选让它可见;只筛「无标签」时新卡
      // 天然在视野,不清。
      if (tagged === 0 && filter.topics.length > 0 && !filter.topics.includes("none")) {
        filter.topics = [];
      }
      // 类型(kind)维同理——**此前漏了这一格**:只筛了类型、没钻到具体标签时,新卡生而
      // 无标签 = 不挂该类型任一标签 = 当场隐身,而收尾只清了文本/标签/时间三维。挂上了
      // 标签就不必清(reconcileKindFilter 保证选集里的标签都属当前类型,新卡随之入选)。
      if (tagged === 0 && filter.kind !== "all") {
        filter.kind = "all";
      }
      // 时间筛选下新建:新卡创建时刻=现在,归「近1天」桶;筛的是别的档(近7天/7天前)
      // 会把新卡当场筛没——清掉让它可见(同上面文本/标签筛选的处理,461)。
      if (timeFilter !== "all" && timeFilter !== "1d") {
        timeFilter = "all";
      }
      composeErr.textContent = partialSaveMsg(failed, why, tagFailed);
      pulseId = id; // 下一次渲染给这张新卡一记朱砂脉冲
      // 新卡落在这块看板落点列的列首。158 G3 / Q1(WD-16b):列滚到底时建的卡
      // 排在列首 = 视野外,列也不回顶(落点不变,不抢用户的滚动位)⇒ 只在这时说一声并给「去看看」。
      void load().then(() => {
        if (!unmounted && cardOffscreen(id)) toastGo(t("board.created"), t("inbox.goSee"), () => flashCard(id));
      });
      composeInput.focus(); // stay open for rapid entry
    },
  });

  function setComposeOpen(open: boolean): void {
    // 收起时焦点在框里 ⇒ 还给「+ 新建任务」那枚(W5 Q2「关完焦点还给打开它的那枚」;此前掉到页面上)。
    const had = !open && compose.contains(document.activeElement);
    compose.hidden = !open;
    addTaskBtn.classList.toggle("on", open);
    composeErr.textContent = "";
    if (open) composeInput.focus();
    else if (had) addTaskBtn.focus({ preventScroll: true });
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

  /** R2:这块看板放不进卡(落点 ⊥)时,「+ 新建卡片」与快捷键 N 都只说为什么、不开框。返回 true = 拦下了。 */
  function blockedCompose(): boolean {
    if (cur === null || cur.landing !== null) return false;
    toastError(t("board.newTaskNoLanding"));
    return true;
  }
  addTaskBtn.addEventListener("click", () => {
    if (compose.hidden && blockedCompose()) return;
    setComposeOpen(compose.hidden);
  });
  // ---- 页头「⋯」菜单(898 B1):复制看板 / 管理看板 ------------------------------------------
  // 点开才建、portal 到 body(同卡片 ⋯ 那只 `.hk-menu` 的样子与层级);打开焦点进第一项、↑ ↓ 走项、Esc / 点别处关、
  // 关完焦点还给「⋯」(W5 Q2 那一族)。这两项此前没有单键,收进来也没有 ⇒ 右侧不印键帽。
  /** 此刻看板上画着的那批卡抄成的 Markdown(renderBoard 写;空看板 / 没在看板态 = null ⇒ 菜单里不出「复制看板」)。 */
  let boardMd: string | null = null;
  let moreMenu: { close(restoreFocus?: boolean): void } | null = null;
  function closeMoreMenu(restoreFocus = false): void {
    moreMenu?.close(restoreFocus);
  }
  function openMoreMenu(): void {
    const item = (id: string, label: string, title: string, run: () => void): HTMLButtonElement => {
      const b = el("button", { className: "hk-item", type: "button", id, title }, [el("span", { className: "hk-label", textContent: label })]);
      b.setAttribute("role", "menuitem");
      b.addEventListener("click", () => {
        closeMoreMenu(true); // 先收菜单、焦点回「⋯」:随后打开的面板关掉时焦点还到它身上
        run();
      });
      return b;
    };
    const items: HTMLButtonElement[] = [];
    // 复制看板:抄的是此刻筛出来的那批(同此前页头那枚)。回执走屏底那句(菜单已收,同卡片单键 C 的报法)。
    const md = boardMd;
    if (md !== null) {
      items.push(
        item("copy-board", t("board.copyBoard"), t("board.copyBoard"), () => {
          void copyText(md).then(
            () => toastAction(t("clipboard.copied")),
            (e) => toastError(copyFailText(e)),
          );
        }),
      );
    }
    // 管理看板:列管理面(B-f 第 2 段)。每笔写落地就广播一声,本视图(onBoardsChanged)与侧栏各取各的,
    // ⛔ 别在这里再 load 一遍(D10)。0043:开的是**这块**看板(列、两个角色、改名 / 删看板都在那一面里)。
    items.push(
      item("manage-cols", t("board.manageCols"), t("board.manageColsTitle"), () => {
        if (cur === null) return; // 首帧 load 之前点不到(钮随 load 显形);防的是那一瞬
        openColumnManager({ boardId: cur.id, onChanged: boardsChanged });
      }),
    );
    const menu = el("div", { className: "hk-menu board-more-menu" }, items);
    menu.setAttribute("role", "menu");
    const r = moreBtn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${Math.max(6, window.innerWidth - r.right)}px`;
    document.body.append(menu);
    arrowWalk(menu);
    const onDown = (e: MouseEvent): void => {
      const n = e.target as Node;
      if (menu.contains(n) || moreBtn.contains(n)) return; // 点「⋯」自己 = 它的 click 来收
      closeMoreMenu();
    };
    const onBlur = (): void => closeMoreMenu();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    const hold = holdKeyboard(menu, menu, { onEscape: () => closeMoreMenu(true), focus: items[0] });
    moreBtn.setAttribute("aria-expanded", "true");
    moreBtn.classList.add("on");
    const me = {
      close(restoreFocus = false): void {
        if (moreMenu !== me) return;
        moreMenu = null;
        document.removeEventListener("mousedown", onDown, true);
        window.removeEventListener("blur", onBlur);
        // 焦点明着还给「⋯」,不靠 holdKeyboard 记下的「打开那一刻的焦点」:点钮不一定让钮拿到焦点(WebKit),那时记下的是别处。
        hold.release(false);
        menu.remove();
        if (restoreFocus) moreBtn.focus({ preventScroll: true });
        moreBtn.setAttribute("aria-expanded", "false");
        moreBtn.classList.remove("on");
      },
    };
    moreMenu = me;
  }
  moreBtn.addEventListener("click", () => {
    if (moreMenu !== null) closeMoreMenu(true);
    else openMoreMenu();
  });
  composeAdd.addEventListener("click", () => void submitNewTask());
  composeClose.addEventListener("click", () => setComposeOpen(false));
  composeInput.addEventListener("input", () => {
    autoGrow(composeInput);
    if (composeErr.textContent === t("board.titleEmpty")) composeErr.textContent = ""; // 开始写了,那句空提交提示收掉
    composeCtl.persistText(composeInput.value, mountSpace); // 断电恢复:输入即写
  });
  composeInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期的 Enter 是上屏,不是提交(ui-audit P0 #1)
    if (e.defaultPrevented) return; // 待办项上的回车已被拿去续下一项(157 G4 / P6,wireChecklistInput)
    // Enter submits; Shift+Enter inserts a newline (let the default through).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submitNewTask();
    } else if (e.key === "Escape") {
      setComposeOpen(false);
    }
  });

  // 回收站卡片的两枚离场动作:还原(可逆、无确认)/ 彻底删除(不可逆、行内两段式)。
  // 51 起不再是常驻按钮 —— 与归档册(508)、灵感回收站(㊱ 起)同一套:⋯ / 右键 / 单键。
  // `acts` 留着但**渲染成空的**:它仍是「彻底删除」那道行内确认的宿主(`.acts:empty` 会塌掉,
  // 视图态下不占位),同看板卡的用法。
  //
  // ⭐ **键义与灵感回收站同为 R 还原 / D 彻底删除**(W3 159 / Q12,WD-36;此前这边被迫取 `U`)。
  //    看板的**视图级**单键 `R` 是「回收站开关」—— 悬停在回收站的卡上按 R,卡片键先接住并
  //    `preventDefault`,`registerViewKeys` 见到已被接住的键就让位(hotkey-menu.ts 那条);指针不在
  //    卡上时 R 照旧是开关(收起回收站)。从随记回收站带来的 R 习惯不再扑空。
  // ⛔ **能力一格没加**:今天卡上就这两枚,本轮只换呈现。灵感回收站多的「复制 / 复制链接」
  //    刻意没搬过来 —— 那是既有的端内差异、不是本轮造的(账在 backlog 用户面)。
  // `imgCount` = 这张卡此刻的配图张数(A7:彻底删除的确认写明连带删掉几张)。
  function trashActionsFor(item: TaskItem, acts: HTMLElement, imgCount: () => number): Act[] {
    return [
      { label: t("board.restore"), key: BOARD_TRASH_KEYS.restore, run: () => void restoreFromTrash(item) },
      {
        label: t("board.deleteForever"),
        key: BOARD_TRASH_KEYS.deleteForever,
        danger: true,
        run: () => {
          const m = imgCount();
          confirmInline(
            acts,
            m > 0 ? t("trash.purgeOneImagesQ", { m }) : t("trash.purgeOneQ"),
            t("board.deleteForever"),
            () => void purgeOne(item),
          );
        },
      },
    ];
  }

  // 归档卡片的唯一操作「取消归档」不再是常驻按钮 —— 508 起搬进 ⋯ / 右键 / 单键 A
  // (见 card() 的 sealed 分支)。刻意仍没有删除入口:归档是史实(不可删)。

  // 移动到其他空间(cross-space-move v1;W3 159 / Q4 起三处共用 move-space.ts):面板进卡片的 .acts 行内宿主
  // (与删除确认同宿主;`.move-panel` 在场即挂起单键,见 card() 的 suspended 判据)。先说后果、选了空间再确认
  // 一拍;任务另说列不随迁(A12:落对方「待办」最上,原来在哪一列)。打开即滚进列的可视区、焦点进面板(A10)。
  // 结果分道在共享件里:只有 moved 重载看板;部分成功先落登记、只留原话与「知道了」;两预检拒原样说清。
  function openMoveSpace(acts: HTMLElement, item: TaskItem): void {
    disarmConfirm();
    const col = cols.find((x) => x.id === item.status);
    const { panel, reveal } = movePanel({
      itemId: item.id,
      sourceSpace: mountSpace,
      targets: otherSpaces,
      carriesDocAt: false, // 任务卡的前端行不带 doc_at(见 MovePanelOpts.carriesDocAt)
      fromColumn: col ? { id: col.id, name: columnName(col) } : null,
      onClose: () => void load(),
      onMoved: () => void load(), // 死 mount(切了视图 / 空间)上 load 自己头一行就退
      onPartial: () => void load(),
      goSee: (space, id) => ctx.openItem(space, id),
      claimConfirm: (off) => (confirmOff = off),
    });
    acts.replaceChildren(panel);
    reveal();
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
    revealConfirm(acts);
  }

  /** 确认刚出现:滚进视野、焦点落在【取消】上(158 G2 / A11 + A18,WD-37 / 新撞 2:列可视区底下那张卡的
   *  红钮要先滚列才点得到;长卡的确认焦点还停在 body / 顶栏钮上)。W5 Q3 ★①(WD-39):此前停在执行钮上,
   *  再按一下回车就删 / 撤回了 —— 一律停【取消】:回车不做破坏的事,要做就 Tab 一下到执行钮。Esc = 取消(armDismiss)。 */
  function revealConfirm(host: HTMLElement): void {
    host.scrollIntoView({ block: "nearest" });
    host.querySelector<HTMLButtonElement>(".act.ghost")?.focus({ preventScroll: true });
  }

  // A card's tags (M:N). Each current tag is a chip with a ✕ to drop it; the ⋯ menu's
  // 标签 opens a keepOpen picker of **all** tags with the ones on the card lit — pick/create
  // adds one, tapping a lit one drops it (675,与手机同形), and the picker stays put so you
  // can change several in a row (each write = add_task_topic / add_task_topic_by_title when the
  // typed name is new / remove_task_topic). Picker adds and drops reflect in place (item.topics +
  // a live `have`) and reconcile the whole board with one load() when the picker closes; the
  // chip ✕ path reloads at once. (chip 上的 draggable:false 只是装饰:挡住「按住 chip 起卡片拖」的是 card() 里的
  // mousedown 落点判,不是这枚属性 —— 见 CARD_CONTROLS。)
  function topicTags(item: TaskItem, refocus: () => void): { root: HTMLElement; openPicker: () => void } {
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
        showOpError(errText(e)); // 横幅就地报错,卡片与选择器都保持在场(ui-audit P0 #6)
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
        showOpError(errText(e)); // 横幅就地报错,卡片与选择器都保持在场(ui-audit P0 #6)
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
        showOpError(errText(e));
        return;
      }
      await load();
      // 158 G2 / A17(WD-24):chip 上的 ✕ 一点就摘,配回执 + 撤销(挂回同一枚)。
      const title = item.topics.find((x) => x.id === topicId)?.title ?? "";
      undoable(true, t("board.undoUntagged", { tag: title }), () => call("add_task_topic", { id: item.id, topicId }));
    }
    // 选择器里再点一次已挂的 = 摘掉:同 addTag 的形,就地更新、⛔ 不整板重载(load() 会拆掉
    // 卡片连带选择器),收起时那发 load() 对齐真相。失败同样横幅就地报错、选择器留场。
    async function dropTag(topicId: string, have: Set<string>): Promise<boolean> {
      clearOpError();
      try {
        await invoke("remove_task_topic", { id: item.id, topicId });
      } catch (e) {
        showOpError(errText(e));
        return false;
      }
      const i = item.topics.findIndex((x) => x.id === topicId);
      if (i >= 0) item.topics.splice(i, 1);
      have.delete(topicId);
      return true;
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
        // ⛔ 157 G4 / P10 起不再标 redundant(用户读成「标签被摘了」,W1 走查 WD-18);上面那段 218 的理由作废。
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
        const had = wrap.contains(document.activeElement);
        renderChips();
        if (had) refocus(); // W5 A4:收起后焦点回这张卡的 ⋯(真改过的那发 load() 重画后照样接回)
        if (changed) void load();
      });
      // 选择器 UI(搜索 + 候选 + Enter 复用/新建)走共享件 tag-picker.ts(与灵感同源),keepOpen
      // 让点完不收起、可连续改多个:选既有 = add_task_topic,输入新名 = add_task_topic_by_title
      // (core 单事务建+挂,见 addTag / createTag),再点已挂的 = remove_task_topic(dropTag)。
      // 回调落定后由 tag-picker 就地重渲候选(点亮态即时翻面)。
      renderTagPicker(wrap, {
        allTopics,
        have,
        keepOpen: true,
        // 回 ok:没写成(横幅已报错)时选择器留着打的字、不出回执(tag-picker 的 commit)。
        onPick: (topicId) =>
          addTag(topicId, have).then((ok) => {
            if (ok) changed = true;
            return ok;
          }),
        onUnpick: (topicId) =>
          dropTag(topicId, have).then((ok) => {
            if (ok) changed = true;
            return ok;
          }),
        onCreate: (title) =>
          createTag(title, have).then((ok) => {
            if (ok) changed = true;
            return ok;
          }),
      });
    }
    renderChips();
    return { root: wrap, openPicker };
  }

  /** 看板 / 归档册卡的「历史」读框(158 G4-A8)。关框时焦点回这张卡的 ⋯ 钮 —— 按 id 现找:框开着时
   *  看板可能已整列重画,旧卡节点早脱离了文档(codex A8 L1)。卡没了就不抢焦点。 */
  function openHistory(item: TaskItem): void {
    openHistoryDialog(item.id, item.title, () => cardMenuBtn(item.id));
  }
  /** 这条此刻那张卡的 ⋯(按 id 现找:浮层开着时看板可能已整列重画)。卡没了 = null(不抢焦点)。 */
  function cardMenuBtn(id: string): HTMLElement | null {
    return [...root.querySelectorAll<HTMLElement>(".tcard")].find((x) => x.dataset.histFor === id)?.querySelector<HTMLElement>(".hk-btn") ?? null;
  }

  function card(item: TaskItem, mode: "board" | "trash" | "sealed" | "holding"): HTMLElement {
    // Highlight a due card at a glance: overdue/today wear a 朱砂 accent. 完成的卡不算
    // (dueAttentionState)——done 列本已靠 .done 的淡出信号说「这条不用管了」,逾期强调
    // 留着是逆信号。
    const st = mode === "board" ? dueAttentionState(item, today, doneCols) : "none";
    const dueCls = st === "overdue" || st === "today" ? ` due-${st}` : "";
    // 0043:`.done`(淡出 + ✓)按**角色**挂(这块看板解析后的完成列),⛔ 不按列 id 字面量 ——
    // 种子 `done` 被取消完成列后不该还淡着,自定义完成列也要淡。
    // ⛔ 列 id 不再进卡片的 class(R6,用户 2026-11-12 拍):此前「进行中 / 待确认」两枚种子列靠它挂朱砂 / 灰色左边线,
    // 自定义列与别的看板没有 ⇒ 所有列一个样。认卡在哪一列走列身的 `data-col`。
    const modeCls = mode === "board" ? (item.status === doneId() ? "done" : "") : mode === "trash" ? "archived" : mode;
    const titleP = el("p", { className: "ttitle", textContent: item.title });
    const c = el("article", { className: `tcard ${modeCls}${dueCls}` }, [titleP]);
    c.dataset.histFor = item.id; // 历史读框关掉时按它找回这张卡(openHistory);⛔ 别复用 taskId —— 那个只挂看板态,拖放按它读列序
    // 颜色标记(0040):整卡一层极淡底色。**三种 mode 都染** —— 颜色是这张卡自己的属性,进了
    // 回收站 / 归档册也该保着;能不能**改**才由 mode 分(见下方 actionsFor 的 board 守卫)。
    applyCardColor(c, item.color);
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
      // 顺带**一律摊开**(704):跳过来是为了看那一条,而命中的词很可能正落在褶子下面。
      expanded.add(item.id);
      locateId = null;
      c.classList.add("just-located");
      armLocate(c);
      hk.want(item.id, true); // W5 Q11:跳过来的这张同时是「选中」、焦点在它的 ⋯ 上 —— 落地就能按单键
      // 落点旁注(W3 159 / A4):搜到的是改过之前的版本,去「历史」里看 —— 紧跟标题(折叠钮落 DOM 后插在两者之间)。
      const said = takeLocateNote(item.id);
      if (said !== null) titleP.after(locateNoteEl(said));
    }

    // ---- 长卡折叠(704)------------------------------------------------------------
    // ⭐ **先一律夹住、落 DOM 后再量**(renderBoard 末尾的 settleFolds):夹子对短卡是空操作
    // ⇒ 量出来没溢出的当场摘掉,屏上与从前逐字同形、也不长钮(本机 348 条里 338 条如此)。
    // ⛔ 别反过来「先摊开、量完再夹」:那会让长卡在首帧闪一下全文,而且列滚动位是 renderBoard
    // 末尾按**夹后**的几何还原的,顺序反了就还错位。两趟都在同一个任务里跑完,中间不绘制。
    // 回收站也折(W3 159 / A16,WD-21 / WD-30:此前「只折看板态」,回收站里一张长卡整段摊开占满一屏 ——
    // 用户拍了搜索 / 回收站 / 标签页展开一律照八行折)。归档册照旧不折(没人点名,保持原样)。
    // ⛔ 方框那条豁免不在这儿判:它要的是**夹后几何**,住 settleFolds(hasBoxBelowFold)。
    if (mode !== "sealed") titleP.classList.add("clamped");

    // ---- 配图 (item images) ----
    // Cached so the 标题 can linkify 「图N」 and the read-only strip renders without refetching
    // on every paint. A 图N with no matching image stays plain text (renderContent's rule).
    let imgs: ImageMeta[] = [];
    // 正文里的待办方框(checklist.ts):点一下翻那一行的标记、整条正文写回。屏上这份
    // 文本是**乐观呈现**的(点完立刻画,不等 IPC),故与 item.title 分开记 —— 写失败时
    // 由 load() 照后端重画,不猜该回滚到哪一版。
    let shownTitle = item.title;
    function paintTitle(): void {
      titleP.replaceChildren(renderContent(shownTitle, imgs, mode === "board" ? toggleBox : undefined));
      if (mode === "board") markFilterHits(titleP, filter.text); // Q8(WD-20):过滤词标红,同搜索页
    }
    // 单飞 + 尾随:连着勾几个框时,在飞的那一发回来前只把最新文本记在 ckPending,
    // 回来再补发一次。⛔ 别改成并发直发 —— 每发都是「整条正文」,乱序落地会让先发
    // 的那份盖掉后发的(丢掉一勾)。
    let ckFlushing = false;
    let ckPending: string | null = null;
    function flushChecklist(): void {
      if (ckFlushing || ckPending === null) return;
      const send = ckPending;
      ckPending = null;
      ckFlushing = true;
      void invoke("rename_task", { id: item.id, title: send }).then(
        () => {
          ckFlushing = false;
          if (ckPending !== null) flushChecklist();
          else load(); // 落盘了才重画:此后 item.title 与屏上这份重新是同一个
        },
        (e) => {
          ckFlushing = false;
          ckPending = null;
          showOpError(t("checklist.toggleFailed", { err: errDetail(e) }));
          load();
        },
      );
    }
    function toggleBox(lineIndex: number): void {
      const next = toggleChecklistLine(shownTitle, lineIndex);
      if (next === null) return; // 那一行已不是待办项(远端刚改过):放弃这一下,⛔ 别猜别的行
      shownTitle = next;
      paintTitle();
      ckPending = next;
      flushChecklist();
    }
    // 方框不依赖配图,首帧就画得出 —— 别等 onMetas 那一发回来(否则每张带清单的卡都
    // 要先闪一下 `- [ ] ` 原文)。图 N 的链接化仍由随后的 onMetas 补上,同一条乐观呈现。
    paintTitle();
    // 标题里「图N」的链接化要知道这条有哪几张图,而缩略图条本来就在取同一份 metas ——
    // 复用它那一发(onMetas),别再自己发一次:此前一屏 N 张卡要发 **2N 次**
    // list_item_images。乐观首帧时 onMetas 是同步回调,标题的链接从第一帧起就是对的。
    function onMetas(metas: ImageMeta[]): void {
      imgs = metas;
      paintTitle();
    }

    if (mode === "trash") {
      // 空的 `.acts` 先挂上:它是「彻底删除」行内确认的宿主(视图态下 `:empty` 塌掉,
      // 不占位),而 actionsFor 要在闭包里拿到它。
      const acts = el("div", { className: "acts" });
      c.append(acts);
      const handle = hk.register(
        c,
        () => trashActionsFor(item, acts, () => imgs.length),
        () => !!c.querySelector(".confirm-q"), // 确认中:键盘归那张表单自己(同看板卡)
        { id: item.id },
      );
      c.append(handle.menu());
      // W3 159 / WD-37:写删除时刻「删于 …」(此前看板回收站的卡连时间都没写;与随记回收站同一句、同一个时间件)。
      // 回收站行恒带 archived_at(core 契约),缺 = 契约断了,响亮抛。
      if (!item.archived_at) throw new Error(`board: trash row ${item.id} without archived_at`);
      c.append(el("div", { className: "done-at deleted-at", textContent: t("trash.deletedAt", { when: when(item.archived_at) }) }));
    } else if (mode === "holding") {
      // 收容区(multiboard-plan §3a):可见、只读,**卡只出不进** —— 唯一的去处是「挪到看板 ▸」(落对方落点),
      // 外加删除(进回收站,同样是离场)。⛔ 没有完成 / 归档(不在任何解析后的完成列里,core 也拒)、没有编辑。
      const acts = el("div", { className: "acts" });
      c.append(acts);
      const handle = hk.register(
        c,
        () => {
          const list: Act[] = [];
          const targets = moveBoardTargets(item, true);
          if (targets.length > 0)
            list.push({
              label: t("boards.moveToBoardMenu"),
              key: "",
              sub: () => targets.map((b) => ({ label: boardName(b), key: "", run: () => void moveToBoard(item, b) })),
            });
          list.push({ label: t("board.delete"), key: BOARD_CARD_KEYS.delete, run: () => void archive(item.id), danger: true });
          return list;
        },
        () => !!c.querySelector(".confirm-q"),
        { id: item.id },
      );
      c.append(handle.menu());
      if (item.topics.length > 0) c.append(el("div", { className: "task-meta task-topic" }, item.topics.map(readonlyTopicChip)));
    } else if (mode === "sealed") {
      // 归档册是**只读视图**:唯一的离场动作「取消归档」不常驻(design-rules「只读视图的
      // 动作只留离场动作、且不常驻」),走与灵感 / 看板同一套 hotkey-menu —— 悬停 ⋯ /
      // 右键 / 单键。⛔ 刻意只有这一条:归档是史实,没有删除入口(想删先取消归档回看板,
      // 再走正常两段式)。键位 A 与看板卡的「归档」同键,是同一根轴上的一进一出;
      // 视图键 G(切归档视图)本就与卡片单键错开。
      // ⚠ 无编辑态 / 无行内确认 ⇒ suspended 用默认的恒 false(没有第二个键盘域要让位)。
      // 158 G4-A8:「历史」是只读的查看,不是动作 —— 不破「只留离场动作」那条(它说的是写);
      // 改过的才出(同随记:没有旧版时点了什么也看不到)。
      const handle = hk.register(
        c,
        () => [
          { label: t("board.unseal"), key: SEALED_CARD_KEYS.unseal, run: () => unseal(item) },
          ...(item.revised ? [{ label: t("inbox.actHistory"), key: SEALED_CARD_KEYS.history, run: () => openHistory(item) }] : [noHistoryAct(SEALED_CARD_KEYS.history)]),
        ],
        undefined,
        { id: item.id },
      );
      c.append(handle.menu());
      // 158 G3 / Q13(WD-33):每张卡写日期(此前只有 ✓ + 标题;分组标题在长列表里早滚出去了)。
      // 完成日优先;0030 之前完成的老卡没有完成日,写入档那天并照实说是「归档于」。
      // 158 G4-A8:改过的在日期后面标一句(同随记卡时间后那枚)。
      // 165 / W5 Q14:写到时刻、两端一个规矩(今天「今天 15:18」/ 别的天「11月5日 15:18」,tasktime.ts::when);组头照旧只写哪天。
      const at = item.done_at ?? item.sealed_at;
      const mark = item.revised ? [el("span", { className: "edited-mark", textContent: t("inbox.editedMark") })] : [];
      // 0043(用户拍 ⑦):成就合一本,每条标出来自哪块看板 —— 只有一块看板时不标(标了也只有「任务」一种,是噪音)。
      // ⚠ 判据与顶上那排筛选同一个(`sealedTagged`,renderSealed 里算):成就来自 ≥ 2 块看板才挂 ——
      // ⛔ 别按「库里有几块看板」判:已删的看板也在 `boards` 里,只剩一块活看板时会凭空挂上「任务」。
      const from = sealedTagged ? boardOfCol(item.status) : null;
      const tag = from ? [el("span", { className: "board-tag", textContent: boardName(from) })] : [];
      if (at !== null) {
        const day = when(at);
        c.append(el("div", { className: "done-at" }, [...tag, item.done_at ? t("board.doneAt", { day }) : t("board.sealedAt", { day }), ...mark]));
      } else if (mark.length > 0 || tag.length > 0) {
        c.append(el("div", { className: "done-at" }, [...tag, ...mark]));
      }
      // 165 / W5 A44(WD-34 / WM-21):归档卡也画标签(只读,不带 ✕ —— 归档册改不动)。此前只在搜索结果里看得到,
      // 读不出归档时分类保没保留。
      if (item.topics.length > 0) c.append(el("div", { className: "task-meta task-topic" }, item.topics.map(readonlyTopicChip)));
    } else {
      // 完成时刻(0030):已完成卡显示「完成于 …」。done_at 可能为 null(本功能上线前
      // 完成的老卡)——那就不显示。与归档册同口径(165 / W5 Q14:写到时刻,tasktime.ts::when)。
      if (item.status === doneId() && item.done_at) {
        c.append(el("div", { className: "done-at", textContent: t("board.doneAt", { day: when(item.done_at) }) }));
      }
      // due/priority: pure-display chips on the card; edits open from the ⋯ menu (㊺).
      // 失败走 op-err 横幅(非破坏),renderError 只留给读取失败(ui-audit P0 #6)。
      // 卡上就地展开的东西(截止 / 优先级 / 颜色 / 标签)不重画就收起时,焦点还给这张卡的 ⋯(W5 A4 / Q2)。
      // ⚠ handle 在下面才注册:这里只在收起那一刻(早已注册完)调用。
      const refocus = (): void => handle.focus();
      // 165 / W5 Q5 ★①:截止 / 优先级写成了给「已设… 撤销」(同换色那种条);撤销 = 再写一次旧值 —— 它们是卡的字段、不进编辑历史
      // (core task::set_due / set_priority 只发字段 op、不落版本)⇒ 撤销不多出一版,也没有哪一版要抹。
      const meta = metaRow(item, today, load, showOpError, refocus, (ch) => {
        if (ch.field === "due") {
          const before = ch.before;
          undoable(true, ch.after === null ? t("board.undoDueCleared") : t("board.undoDue", { day: dueDayText(ch.after) }), () =>
            call("set_task_due", { id: item.id, dueOn: before }),
          );
        } else {
          const before = ch.before;
          undoable(
            true,
            ch.after === null ? t("board.undoPriorityCleared") : t("board.undoPriority", { p: PRIORITY_LABEL[ch.after] }),
            () => call("set_task_priority", { id: item.id, priority: before }),
          );
        }
      }, item.status === doneId());
      // 颜色(0040):色板就地展开在 due/priority 那一行(同它们的形),平时是空壳、不占位。
      // ⚠ 只在活跃看板挂 —— core 的 set_task_color 带 archived/sealed 守卫,回收站与归档册
      // 的卡改不动;**显示条件 = 接收条件**,别摆一条点了必然报错的入口。
      const colorWrap = el("span", { className: "slot color-slot" });
      if (mode === "board") meta.root.append(colorWrap);
      // 158 G4-A8:改过的卡在这一行标一句「改过」(同随记卡;此前桌面看板卡看不出改没改过,手机早有)。
      // ⚠ 挂进 meta 行 = 同时登记进 board.css 那串收起白名单(`.edited-mark`),否则别的格都空的卡上看不见。
      if (item.revised) meta.root.append(el("span", { className: "edited-mark", textContent: t("inbox.editedMark") }));
      // 失败 = 横幅就地报错、不改本地态(ui-audit P0 #6);成功走 load() 重渲(同其它写路径,
      // 本地不猜真相)。
      // `undo`:数字键那条「悬停即按」的快速通道才配发撤销回执(716)—— 色板上点选是看着
      // 选的,回执只会是噪音;误敲一个数字才是它要兜的形。
      async function setColor(hex: string | null, undo = false): Promise<boolean> {
        const prev = item.color;
        clearOpError();
        try {
          await invoke("set_task_color", { id: item.id, color: hex });
        } catch (e) {
          showOpError(errText(e));
          return false;
        }
        await load();
        if (undo) undoable(true, t("board.undoColored"), () => setColor(prev));
        return true;
      }
      // 署名(0033):只在活跃看板显——回收站/归档册是「已处理完」的语境,不铺
      // (2026-08-05 用户拍板的铺开范围)。挂进 due/priority 那一行末尾。
      if (boardView === "board") {
        const sig = signatureChip(mountSpace, item.born_device);
        if (sig) meta.root.append(sig);
        // 留言徽章(§4.7):N=0 不显(那时的入口在 ⋯ 菜单的「留言」)。回收站/归档册
        // 不铺——同署名的铺开范围。
        // ⭐ 第 4 个实参 = 宿主正文,画在浮层顶上:居中浮层会盖住这张卡本身(601 补,用户
        // 实测「卡在中间时留言框里看不到原内容」)。⛔ 别省。
        const badge = commentBadge(mountSpace, item.id, () => void load(), () =>
          openComments(mountSpace, item.id, () => void load(), item.title, () => cardMenuBtn(item.id)),
        );
        if (badge) meta.root.append(badge);
      }
      c.append(meta.root);
      // tags (M:N): set-tag chips show on the card (each with a ✕ to drop it); adding a
      // tag opens the picker from the ⋯ menu's 标签 (㊺). Reuses .task-meta chip styling.
      const tags = topicTags(item, refocus);
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
      // 失败不在这里兜成文案:让它 reject,hotkey-menu 统一报「复制失败:{原因}」(902 F3)。
      const copyFeedback = async (): Promise<string> => {
        await copyText(item.title);
        return t("board.copied");
      };
      // 复制这条任务的深链接(zhujian://open?…&item=…):粘到别的笔记 / 发给对方设备都能
      // 直接打开它(见 deeplink.ts)。菜单反馈复用 copy 一族的「点一下闪一下」。
      const copyLinkFeedback = async (): Promise<string> => {
        await copyText(await buildItemDeepLink(item.id));
        return t("board.linkCopied");
      };
      // 列间移动: advance/retreat the card one column. The target column's current DOM
      // order (excludes this card — cross-column) is the base; the card appends to the
      // end of the target column. Routes through the same reorder paths as a drop, so a
      // topic filter is honoured (visible-merge server-side).
      // 158 G3 / Q2:从「左右邻居」推广成「任意一列」—— ⋯「移到 ▸」子菜单列出所有活着的列(本列除外),
      // `]` `[` 仍是去左右邻居的快速键(调用方算好邻居再交进来)。目标必须是活着的列(已删的列 core 会拒)。
      // `said` = 回执换一句(165 / W5 Q7:⋯「完成」/ X 说手机点圈那句「已完成」,别的路照旧「已移到「…」」)。
      function moveTo(target: BoardColumn, said?: string): void {
        if (busy || !target.accepts_cards || target.id === item.status) return;
        const toStatus = target.id;
        const fromStatus = item.status;
        // 716 撤销要回到**原位**(不是源列列尾):先记下源列此刻的序(含本卡),撤销时按这份序
        // 整列写回 —— 与拖放同一条 reorder 路,源列在这期间被别人动过就由 core 的陈旧检查拒掉。
        const srcOrder = [...(ownColBody()?.querySelectorAll<HTMLElement>(".tcard") ?? [])].map(
          (x) => x.dataset.taskId!,
        );
        const targetBody = board.querySelector(`.col[data-col="${toStatus}"] .col-body`);
        const base = targetBody
          ? [...targetBody.querySelectorAll<HTMLElement>(".tcard")].map((x) => x.dataset.taskId!)
          : [];
        const ordered = [...base, item.id];
        // W5 A3:挪去别的列 = 卡离开这里 —— 选中(连同焦点)留在原位后一张(连着按 `]` 一张张往右送;跟过去看用回执的
        // 「去看看」)。⛔ 别让选中跟着卡走:跟过去就得把目标列滚到列尾,抢了 158 G3 / Q1 定的「落点不变、不抢滚动位」。
        hk.leave(c);
        targetBody?.append(c); // 手势即回执:按键即挪到目标列尾(与拖放同规),load() 校正
        bumpColCount(fromStatus, -1); // 移列必跨列:源 −1、目标 +1(与拖放同规)
        bumpColCount(toStatus, 1);
        const persist = filtered ? reorderVisible : reorder;
        void persist(item.id, fromStatus, toStatus, base, ordered).then((ok) => {
          undoable(
            ok,
            said ?? t("board.undoMoved", { col: columnName(target) }),
            () => (busy ? Promise.resolve(false) : persist(item.id, toStatus, fromStatus, srcOrder.filter((x) => x !== item.id), srcOrder)),
            goSeeIfHidden(item.id), // Q1(WD-16a):挪进长列落列尾 = 多半在视野外
          );
        });
      }
      // 列内置顶 / 置底:同列重排,故 from === to === item.status;`base` 含自己(同列口径,
      // 与 drop 那条一致)。长列里这是「不用拖」的那条路——边缘自动滚动能拖到另一头了,但
      // 二十屏的列拖过去要按着不放好几秒。过滤态下走 visible-merge(隐藏的卡原地不动)。
      // ⛔ 键位刻意不用 B(Bottom):待办列的 B 是「撤回为随记」,同一张卡上会两义。
      /** 本卡所在列的列体(DOM 口径,与 moveEnd 的 `base` 同源;actionsFor 只在开菜单/按键时
       *  现读,那时卡早已挂上 DOM)。 */
      function ownColBody(): HTMLElement | null {
        return board.querySelector<HTMLElement>(`.col[data-col="${item.status}"] .col-body`);
      }
      function moveEnd(toTop: boolean): void {
        if (busy) return;
        const colBody = ownColBody();
        if (!colBody) return;
        const base = [...colBody.querySelectorAll<HTMLElement>(".tcard")].map((x) => x.dataset.taskId!);
        const others = base.filter((x) => x !== item.id);
        const ordered = toTop ? [item.id, ...others] : [...others, item.id];
        if (ordered.join(" ") === base.join(" ")) return; // 已在那一头:不落账、不动 DOM
        // 手势即回执(同 moveTo / drop):按键即挪,真相由随后的 load() 校正。挪完把卡滚
        // 进视野——否则长列里按完键,卡跑到了看不见的另一头,屏上「什么也没发生」。
        if (toTop) colBody.prepend(c);
        else colBody.append(c);
        c.scrollIntoView({ block: "nearest" });
        // 165 / W5 Q5 ★①(WD-40):此前一声不吭、也撤不回 —— 卡在列尾按 T 挪到列首,看不到它去了哪。撤销 = 同一条重排路把
        // 原来的序写回去(位置不是正文,不进编辑历史:撤销不多出一版,也没有要抹的);这期间列被别人动过就由 core 的陈旧检查拒掉、横幅报错。
        const status = item.status;
        const persist = filtered ? reorderVisible : reorder;
        void persist(item.id, status, status, base, ordered).then((ok) =>
          undoable(ok, toTop ? t("board.undoToTop") : t("board.undoToBottom"), () =>
            busy ? Promise.resolve(false) : persist(item.id, status, status, ordered, base),
          ),
        );
      }
      // 截止 / 优先级 / 标签: the on-card chips are pure display now (㊺), so the menu opens
      // the editors directly via the meta/tag controllers — one source of truth, no chip click.
      function actionsFor(): Act[] {
        const list: Act[] = [
          { label: t("board.edit"), key: BOARD_CARD_KEYS.edit, run: () => requestEdit(item.id) },
          // W5 A9:有配图才有「看图」(从第一张看起;同点缩略图那条路)
          ...(imgs.length > 0 ? [{ label: t("inbox.actImages"), key: BOARD_CARD_KEYS.images, run: () => void openLightbox(imgs, 0) }] : []),
          { label: t("board.copy"), key: BOARD_CARD_KEYS.copy, feedback: copyFeedback },
          { label: t("board.copyLink"), key: BOARD_CARD_KEYS.copyLink, feedback: copyLinkFeedback },
          { label: t("board.tags"), key: BOARD_CARD_KEYS.tags, run: tags.openPicker },
          { label: t("board.due"), key: BOARD_CARD_KEYS.due, run: meta.openDue },
          { label: t("board.priority"), key: BOARD_CARD_KEYS.priority, run: meta.openPri },
          // 留言(§4.7,与灵感同键):N=0 时卡片上没有徽章,这里是写第一条的唯一入口。
          { label: t("board.comments"), key: BOARD_CARD_KEYS.comments, run: () => openComments(mountSpace, item.id, () => void load(), item.title, () => cardMenuBtn(item.id)) },
        ];
        // 158 G4-A8:历史(只读读框,复用随记那份目录 + 长文那套比对)。改过的才有,同随记。
        // 「改过」读的是库里派生的 revised(改完 save 走 load() 重拉就出来),⛔ 别在前端猜。
        if (item.revised)
          list.push({ label: t("inbox.actHistory"), key: BOARD_CARD_KEYS.history, run: () => openHistory(item) });
        else list.push(noHistoryAct(BOARD_CARD_KEYS.history)); // 165 / W5 A45:没改过的按 V 说一句(菜单里照旧不列)
        // 颜色(0040):菜单里只出一项「颜色 H」开色板;1-7 / 0 八枚数字键是 `hidden` 的快速
        // 通道(悬停即按)。⛔ 八枚全摊进菜单会把 14 行撑成 22 行 —— 发现性改由色板上印着的
        // 数字键兑现。⚠ H = Hue:E/C/K/L/S/P/Y/T/F/A/B/M/D 是卡片键、N/R/G 是**视图级**键
        // (registerViewKeys,与卡片键共享同一个 document),H 是剩下里唯一有语义的。
        // ⚠ 数字键此前全空(board.ts/notebook.ts 里那两处 `=== "1"` 是 localStorage 的**值**)。
        if (mode === "board") {
          list.push({
            label: t("board.color"),
            key: BOARD_CARD_KEYS.color,
            run: () => openCardColorPicker(colorWrap, item.color, (hex) => void setColor(hex), refocus),
          });
          CARD_COLORS.forEach((cc, i) => {
            // 再按同一个数字 = 取消(省掉「先想起清除键是哪个」这一步;0 仍恒清)。
            list.push({
              label: cc.name,
              key: String(i + 1),
              hidden: true,
              run: () => void setColor(item.color === cc.hex ? null : cc.hex, true),
            });
          });
          list.push({ label: t("board.colorNone"), key: "0", hidden: true, run: () => void setColor(null, true) });
        }
        // 左右邻居按本看板的活列算(0043 起 `cols` 只剩本看板的活列,已删的进了收容区)。
        const live = cols;
        const i = live.findIndex((col) => col.id === item.status);
        // 列内置顶/置底同理只给活着的列(已删的列 core 会拒重排);列里只有它一张时不出
        // (显示条件 = 接收条件,别摆一条点了必然无事发生的动作)。时间序下同样不出 ——
        // 它写的是 `position`,而那时列里根本不按 position 排,按了屏上不会动(500);
        // dueOnly 同理(sortByDue 接管,同一个「按了屏上不会动」)。
        if (boardSort === "manual" && !dueOnly && i >= 0 && (ownColBody()?.querySelectorAll(".tcard").length ?? 0) > 1) {
          list.push({ label: t("board.moveToTop"), key: BOARD_CARD_KEYS.toTop, run: () => moveEnd(true) });
          list.push({ label: t("board.moveToBottom"), key: BOARD_CARD_KEYS.toBottom, run: () => moveEnd(false) });
        }
        // 158 G3 / Q2(WD-17):菜单此前只能挪到相邻一列 ⇒ 改成「移到 ▸」子菜单,列出所有活着的列(本列除外)。
        // `]` `[` 仍是去右 / 左邻居的单键(hidden:不占菜单行,设置「快捷键」页与指南照旧写着)。
        // 已完成的卡另给一条直达「打回「待办」」(此前打回只写「移到待确认」,要连挪几次)。
        if (i >= 0 && i < live.length - 1)
          list.push({ label: t("board.moveToCol", { col: columnName(live[i + 1]) }), key: BOARD_CARD_KEYS.nextCol, hidden: true, run: () => moveTo(live[i + 1]) });
        if (i > 0)
          list.push({ label: t("board.moveToCol", { col: columnName(live[i - 1]) }), key: BOARD_CARD_KEYS.prevCol, hidden: true, run: () => moveTo(live[i - 1]) });
        const targets = live.filter((col) => col.id !== item.status);
        if (targets.length > 0)
          list.push({
            label: t("board.moveToMenu"),
            key: "",
            sub: () => targets.map((col) => ({ label: columnName(col), key: "", run: () => moveTo(col) })),
          });
        // 0043(用户拍 ⑥):「挪到看板 ▸」—— 别的活看板里放得进卡的那几块,落对方落点列首。只有一块看板时不出。
        const boardTargets = moveBoardTargets(item);
        if (boardTargets.length > 0)
          list.push({
            label: t("boards.moveToBoardMenu"),
            key: "",
            sub: () => boardTargets.map((b) => ({ label: boardName(b), key: "", run: () => void moveToBoard(item, b) })),
          });
        // 165 / W5 Q7 ★①(WD-26 / WX-01):「完成」= 移到「已完成」,不在那一列时才有;回执同手机点圈那句「已完成 撤销」。
        // 已完成卡上的「打回「待办」」配同一枚 X(一进一出;此前右边空着,C 节第五条)。
        // 0043:完成 / 落点读 core 解析的角色;纯分类看板(没有完成列)没有「完成」、没有「归档」。
        const doneCol = live.find((col) => col.id === doneId());
        if (item.status !== doneId() && doneCol)
          list.push({ label: t("board.complete"), key: BOARD_CARD_KEYS.complete, run: () => moveTo(doneCol, t("main.completed")) });
        const landing = live.find((col) => col.id === landingId());
        if (item.status === doneId() && landing)
          list.push({ label: t("board.backToCol", { col: columnName(landing) }), key: BOARD_CARD_KEYS.complete, run: () => moveTo(landing) });
        // 归档: only a 已完成 card can enter the 成就册 (viewable, undeletable). Key A
        // (Archive) — the view-level key for the 归档 view is G, deliberately different
        // (card keys and view keys share the document and must not collide).
        if (doneCol && item.status === doneCol.id)
          list.push({ label: t("board.seal"), key: BOARD_CARD_KEYS.seal, run: () => sealOne(item.id) });
        // 撤回为灵感: a 灵感 is just a not-yet-clarified task, so only the least-mature
        // column (待办) may retreat into it. Single-entity: flips the SAME subject's stage
        // back to 灵感 (已归类 if it still carries a tag, else 未归类) — nothing is deleted.
        // 0043:「卡所在看板的落点」才能撤回(core revert_to_idea 同口径,multiboard-plan §4)。
        if (landing && item.status === landing.id)
          list.push({
            label: t("board.revertToIdea"),
            key: BOARD_CARD_KEYS.revert,
            // 有截止 / 优先级时确认句说清会清掉它们(同手机 cardpanel.revertQMeta)。
            run: () =>
              confirmInline(
                acts,
                item.due_on !== null || item.priority !== null ? t("board.revertQMeta") : t("board.revertQ"),
                t("board.revertYes"),
                () => void revert(item),
              ),
          });
        // 删除 → soft-archive into 回收站 (reversible). The FIRST time it shows an inline
        // confirm with a 不再提示 opt-out (persisted), after which it deletes straight away.
        // 移动到其他空间(cross-space-move v1):≥2 空间才出现。
        if (otherSpaces.length > 0 && !movePartialNote(item.id))
          list.push({ label: t("board.move"), key: BOARD_CARD_KEYS.move, run: () => openMoveSpace(acts, item) });
        list.push({ label: t("board.delete"), key: BOARD_CARD_KEYS.delete, run: () => void archive(item.id), danger: true });
        return list;
      }
      // A card mid inline-rename / mid-confirm owns the keyboard (its own Enter/Esc).
      const handle = hk.register(
        c,
        actionsFor,
        () => !!c.querySelector(".edit-form") || !!c.querySelector(".confirm-q") || !!c.querySelector(".move-panel"),
        { id: item.id }, // 重画后按它把选中 / 焦点接回同一张;挪了列的跟着卡走(W5 A3)
      );
      c.append(handle.menu());

      // Board cards move by drag, not buttons. The closure `dragging` carries the id;
      // dataset.taskId lets a drop read the column's order straight from the DOM.
      c.dataset.taskId = item.id;
      // ⛔ 时间序下不许拖(500):列里的顺序由 `created_at` 决定,拖到哪儿松手都会弹回去
      // ——那是「点了没反应」的同族,比不能拖更糟。切回「手动」即恢复。
      // 一并被停掉的还有拖动改列 / 拖卡片打标签 / 拖到归档区(它们共用这一个 dragstart),
      // 但**每条都有等价的非拖拽入口**:`]`/`[` 改列 · `L` 打标签 · `A` 归档,⋯ 菜单里都在。
      // (拖标签 pill 到卡片那条方向不走这里,时间序下照常可用。)dueOnly 同理停拖拽——
      // 那档显示序是 sortByDue 算出来的,拖完下一次重画会被按到期日重新排回去,不停会
      // 看着像「拖了没用」。
      // 这张卡此刻能不能当拖源:排序轴之外还有编辑态 —— 编辑框里要能划选字,而 draggable 的
      // 祖先会让子输入框里选不了字(openEdit 关掉它,load() 换新卡时才回来)。
      const canDrag = (): boolean => boardSort === "manual" && !dueOnly && !c.querySelector(".edit-form");
      c.draggable = canDrag();
      // 按在 ⋯ 钮 / 标签 chip / 勾选框 / 留言徽章上的那一按**不是拖卡**(用户面 99):Blink 只要
      // 祖先 draggable 就优先起拖,子元素自己的 draggable=false 挡不住 ⇒ 手抖挪几像素再松,起了
      // 一次拖、点击被吞 —— 「有时点 ⋯ 没反应」那一族。同 671 给随记卡的形:mousedown 看落点,
      // 落在交互件上就把 draggable 临时关掉,这一按走控件自己的路;mouseup / dragend 恢复成
      // canDrag() 算出的值(⛔ 别一律恢复 true:时间序 / 到期筛 / 编辑态下本就不可拖)。标题字
      // 照旧是拖源 —— 看板卡是标题不是正文,「标题划不选」是可拖卡片的老取舍,不在这条里。
      c.addEventListener("mousedown", (e) => {
        if (!(e.target as HTMLElement).closest(CARD_CONTROLS)) {
          noDragHint(e);
          return;
        }
        c.draggable = false;
        document.addEventListener("mouseup", () => (c.draggable = canDrag()), { once: true });
      });
      // 158 G3 / Q13(WD-28):按时间排序 / 只看到期时卡拖不动,按住一拖只会变成选字 —— 排序钮的 title
      // 说过,可没人去悬停它。⇒ 按住纸面挪出 6px 就在指针边上说一句,一按至多一次。编辑态不算(那是选字)。
      function noDragHint(down: MouseEvent): void {
        if (down.button !== 0 || canDrag() || c.querySelector(".edit-form")) return;
        const onMove = (e: MouseEvent): void => {
          if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 6) return;
          stop();
          flashToast(e.clientX, e.clientY - 12, dueOnly ? t("board.noDragDue") : t("board.noDragSorted"), { ms: 2600 });
        };
        const stop = (): void => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", stop);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", stop);
      }
      c.addEventListener("dragstart", (e) => {
        // 只认卡片自己的 dragstart:拖正文里的缩略图 / 「图N」链接,浏览器起的是它自己那种拖,
        // 事件落在子元素上再冒上来,不是拖卡(同随记卡)。
        if (e.target !== c) return;
        if (busy) {
          e.preventDefault();
          return;
        }
        dragging = { id: item.id, from: item.status };
        // 侧栏看板名据此接放、亮起(拖到别的看板 = 挪过去,用户拍 ⑥;卡自己那块不接,R1)。
        setDraggingCard({ id: item.id, own: cur?.id ?? null });
        c.classList.add("dragging");
        // 归档条只对能落进去的拖动现身(完成列的卡),显示条件=接收条件。
        if (item.status === doneId()) board.classList.add("drag-done");
        e.dataTransfer?.setData("text/plain", item.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      c.addEventListener("dragend", () => {
        dragging = null;
        setDraggingCard(null);
        stopAutoScroll();
        c.classList.remove("dragging");
        board.classList.remove("drag-done");
        clearDropHovers();
        detachDropLine();
        // 浏览器自己那种拖(缩略图)不发 mouseup,只有 dragend 冒上来 —— 在这儿也恢复,免得
        // 下一次按住纸面那一拍还顶着上一按关掉的 draggable。
        c.draggable = canDrag();
      });

      // 标签 pill 拖到本卡 = 给本卡打这个标签(pill→card)。只认 draggingTopic;卡片重排
      // (dragging)时早返回,交给列处理。stopPropagation 免得冒泡到列的 dragenter/dragover/drop
      // (列本就 !dragging 自退,双保险)。已挂该标签则不作接收目标(无高亮、不落库)。
      onDragTarget(c, (e) => {
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
        if (c.querySelector(".edit-form") || c.querySelector(".confirm-q") || c.querySelector(".move-panel")) return;
        if ((e.target as HTMLElement).closest(CARD_CONTROLS)) return;
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
    // is made non-draggable while editing (canDrag() 也认这个态,mouseup 恢复时不会把它
    // 打回 true); load() restores a fresh draggable card.
    function openEdit(): void {
      c.draggable = false;
      const input = el("textarea", { className: "edit-input", rows: 1, value: item.title });
      wireChecklistInput(input); // Shift+Enter 续待办项 / Ctrl+L 起一条 / Tab 缩进(562,600)
      const err = el("span", { className: "edit-err" });

      // 配图编辑器:在标题框粘贴截图(Ctrl+V)→ 挂为下一张「图N」;缩略图可删(编号不复用)。
      // ＋图 选文件入口已删——配图统一靠粘贴(Ctrl+V)。
      const imgEditor = el("div", { className: "img-editor" });
      const imgErr = el("p", { className: "img-err", hidden: true });
      const strip = imageStrip(item.id, { editable: true });
      const onImgErr = (e: unknown) => {
        imgErr.textContent = errText(e);
        imgErr.hidden = false;
      };
      const afterAttach = () => {
        imgErr.hidden = true;
        void strip.reload();
      };
      wirePasteToAttach(input, item.id, afterAttach, onImgErr);
      imgEditor.append(strip.root, imgErr);

      // 放大编辑(⤢):长正文在 200px 起的窄列里折成十几行、框一长就顶出视口,只能边打字
      // 边滚列体。放大 = 把**同一个** `.edit-form` 整块搬进一张浮层面板,不是另起一个编辑器
      // —— 文档级按键监听 / 落盘钩 / 配图粘贴 / 清单缩进全是原来那些节点上的那些,保存链
      // 一个字节没改。⛔ **没有「缩回小框」这条出口**:出口只有 Enter 保存 / Esc 取消 /
      // 点遮罩保存,与就地编辑逐字同义(多一条缩回就是多一个中间态,而编辑态本就是全局单例)。
      let zoomed = false;
      let overlay: HTMLElement | null = null;
      let saving = false; // 幂等:点别处/回车/切卡可能并发触发,保存中再触发直接让位
      // 已落盘的标题:改名成功、删图那步却失败时,重试不能再改一遍同样的名(no-op rename 也会留一条重复版本)。
      let savedTitle = item.title;
      // 空的待办项保存时摘掉(901,同随记编辑态):要写的是摘过的那份。⛔ 「框里的字动过」这一格不能省 ——
      // 旧卡本来就带空项时,打开没改就点别处 / 回车也走到这里,省了它就成了「看一眼就多一版历史」;动过而
      // 摘完与原文相同(只添了个空项)同样不写。
      const toSave = (v: string): string => dropEmptyChecklistLines(v);
      const titleChanged = (): boolean => {
        if (input.value === savedTitle) return false;
        const v = toSave(input.value);
        return v.trim() !== "" && v !== savedTitle;
      };
      const save = async () => {
        if (saving) return;
        saving = true;
        try {
          if (titleChanged()) {
            const v = toSave(input.value);
            await invoke("rename_task", { id: item.id, title: v });
            savedTitle = v;
          }
          await strip.commitDeletes(); // 148:编辑态里标了删的图,随保存这一步才真删
        } catch (e) {
          // 竞态下编辑器可能已被重画拆走:错误必须落在还看得见的地方(op-err 横幅),
          // 附草稿不无声(codex P1 审 H3)。
          if (err.isConnected) err.textContent = errText(e);
          else showOpError(t("board.renameFailed", { title: item.title, err: errDetail(e), draft: input.value }));
          saving = false;
          return;
        }
        activeEditFlush = null; // 已落盘:随后的 load() 不得再 flush 同一改动(会造重复版本)
        keepFocusThroughZoom();
        load(); // 重渲会拆掉本编辑态的文档级监听(activeEditCleanup)
      };
      // 提交编辑:空标题(后端拒空)或没改动、且没有标了删的图,都当「取消」——直接重渲回视图、
      // 不打后端(no-op rename 也会 UPDATE 触发历史归档、留一条重复版本,所以未改动必须短路)。
      // 放大态里表单搬进了浮层(不在卡里了):收场那一发重画,卡片控制器认不出「焦点刚才在这张卡上」⇒ 点名要回来
      // (W5 A4:此前放大编辑里 Esc 丢掉 / 回车存下后焦点掉到页面上)。就地编辑那形不用 —— 表单在卡里,控制器自己认得。
      function keepFocusThroughZoom(): void {
        if (zoomed && form.contains(document.activeElement)) hk.want(item.id, true);
      }
      const commit = (): void => {
        if (!titleChanged() && strip.pendingDeletes() === 0) {
          keepFocusThroughZoom();
          void load();
          return;
        }
        void save();
      };
      // ⛔ 放大态下不许写 inline 高度:那里的几何由面板的 flex 撑(正文框吃满剩余高度、
      // 框内自己滚),而 autogrow 的「长到全文可见」在一张定高面板里没有意义 —— 它写的
      // `style.height` 会把 flex 算出来的高度整个覆盖掉,框当场缩成内容那么高。
      input.addEventListener("input", () => {
        if (!zoomed) autoGrow(input);
        disarmDiscard();
      });
      // 158 G1 / A1:Esc 是唯一丢弃的路 ⇒ 改过了先提示、再按一次才丢(同随记 157 P1 那条,
      // 文案共用 inbox.discardHint)。提示挂在 .edit-form 里,放大态随表单一起进面板。
      const discardHint = el("p", { className: "discard-hint", hidden: true, textContent: t("inbox.discardHint") });
      let discardArmed = false;
      function disarmDiscard(): void {
        discardArmed = false;
        discardHint.hidden = true;
      }
      // Esc 取消 / Enter 提交 监听在文档级,而非输入框上 —— 焦点离开框(点了缩略图 /
      // 卡片空白)时也生效。Shift+Enter 仍在框内换行(shiftKey 让位)。别的输入框(如 compose
      // 新任务)保留自己的键:目标是另一个 input/textarea 时不劫持。load() 会拆掉这些监听。
      const onKey = (e: KeyboardEvent) => {
        if (e.isComposing) return; // IME 组合期的 Enter/Esc 属于输入法,不是提交/取消(ui-audit P0 #1)
        const t = e.target;
        if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t !== input) return;
        // W5 A10(WD-09):焦点在一枚钮上(⤢ 放大编辑 / 删图的 ×)时回车归那枚钮 —— 此前 ⤢ 上按回车不放大,
        // 反把编辑框收起、改的字一声不吭存成一版(空格才放大);同随记 157 G2① 那条。Esc 照旧取消。
        if (e.key === "Enter" && t instanceof HTMLButtonElement) return;
        if (e.defaultPrevented) return; // 待办项上的回车已被拿去续下一项(157 G4 / P6)
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          // 158 G1 / A1(照随记 157 P1):改过了(正文或标了删的图)先说一句,再按一次才丢。
          const dirty = input.value !== savedTitle || strip.pendingDeletes() > 0;
          if (dirty && !discardArmed) {
            discardArmed = true;
            discardHint.hidden = false;
            return;
          }
          activeEditFlush = null; // Esc = 明确丢弃:load() 的落盘钩不得把它救回来
          keepFocusThroughZoom();
          void load();
        }
      };
      // 点这张卡以外的任何地方 = 默认保存(需求:点别处即提交)。落点在本卡内(标题框 /
      // 缩略图 / 提示行)不算离开;看大图遮罩、别卡的 ⋯ 菜单浮层、留言浮层(portal 到 body)也放行
      // ——那是编辑态的卫星 UI,不该误触发保存(白名单=SATELLITE_LAYERS,一处登记)。
      const onDown = (e: MouseEvent): void => {
        const t = e.target as HTMLElement;
        if (c.contains(t)) return;
        // 放大态:面板 = 卡内、遮罩 = 卡外,与就地编辑同义。⚠ 这一判必须在白名单之前 ——
        // 遮罩自己带着 `.cm-overlay`(为复用那张深压底),`closest` 会当场把它放行,
        // 「点面板外即保存」就永远不会发生。面板内的点击照旧由 closest 命中祖先遮罩而放行。
        if (t.classList.contains("ze-overlay")) {
          commit();
          return;
        }
        if (t.closest(SATELLITE_LAYERS)) return;
        commit();
      };
      document.addEventListener("keydown", onKey);
      document.addEventListener("mousedown", onDown);
      activeEditCleanup = () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("mousedown", onDown);
        // 放大面板与编辑态同生死:三个落点(load 落盘后重画 / load 重画前 / unmount)都在
        // 这里收口 —— 它挂在视图根下,切视图那一发确实会连根带走,但保存/取消回到就地
        // 视图的那两发不会,漏收就是一张永远关不掉的遮罩。
        overlay?.remove();
        overlay = null;
        zoomed = false;
      };
      // 刷新前落盘(P1 #9b):此前 load() 重画只摘监听、半打的标题静默蒸发(远端一有
      // 动静就丢)。未改动/空/保存中 = 无事(false);失败上 op-err 横幅并附草稿,不无声。
      // 148:标了删的图也算「已改动」,同一刻落 —— 否则远端一刷新,标记就悄悄没了。
      activeEditFlush = async () => {
        const v = toSave(input.value); // 刷新前落盘也是一次提交:空项同样摘掉
        if (saving || (!titleChanged() && strip.pendingDeletes() === 0)) return false;
        if (titleChanged()) {
          try {
            await invoke("rename_task", { id: item.id, title: v });
            savedTitle = v;
          } catch (e) {
            showOpError(t("board.renameFailed", { title: item.title, err: errDetail(e), draft: v }));
            return false;
          }
        }
        try {
          await strip.commitDeletes();
        } catch (e) {
          showOpError(t("itemImages.deleteFailed", { err: errDetail(e) }));
        }
        return true;
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
      // 902 F1:就地编辑态的框下常驻一行「回车或点别处保存 · Esc 不要了」(同随记编辑态那行、同一个键;用户这次
      // 改了主意 —— 此前是「隐式手势,不常驻说明书」)。放大面板里它让位给面板底那句 `board.zoomHint`(CSS 藏)。
      const editHint = el("p", { className: "edit-hint", textContent: t("inbox.editHint") });
      // 报错与放大钮同占一行:`.edit-err:empty` 本就收起,这一行的高度平时只由那枚小钮决定。
      // 复用卡上小钮那一档(`.act.ghost`),只在 CSS 里收窄单字符的左右留白 —— 别为它另拍一套。
      const zoomBtn = btn("⤢", "ghost edit-zoom", () => openZoom());
      zoomBtn.title = t("board.zoomEdit");
      zoomBtn.setAttribute("aria-label", t("board.zoomEdit"));
      // ⛔ 这一行必须在正文框**之前**:它要服务的正是「框长过视口」那一态,而那一态里框底
      // 在屏幕外 —— 钮挂在框下面等于「最需要它的时候它不在屏上」(实测 154px 窄列、十行
      // 正文:框高 466、底边 751,窗才 680)。报错行跟着上移是顺带的好处,不必滚到底才看见。
      const form = el("div", { className: "edit-form" }, [el("div", { className: "edit-bar" }, [err, zoomBtn]), input, discardHint, editHint, tagView, imgEditor]);

      function openZoom(): void {
        if (zoomed) return;
        zoomed = true;
        // 搬 DOM = 节点重新插入 = 失焦且选区归零,先记下光标再还原(不然放大后光标跳回开头)。
        const at = [input.selectionStart, input.selectionEnd] as const;
        // ⛔ 遮罩只能挂 body:`.main-col` 是 `position:relative; z-index:1`,**它建立了一个
        // 堆叠上下文** —— 挂在视图根下的遮罩,z-index 再大也只在 main-col 内部排序,盖不住
        // z-index:2 的侧栏(实测:面板左边那点 `elementFromPoint` 命中的是 `.sidebar`,
        // 侧栏既没被压暗、还点得动 ⇒ 点一下就切视图)。留言浮层挂 body 正是同一个道理。
        // 代价是 `.edit-form` 那一族样式全 scoped 在 `.v-board` 下,故套一层**只为作用域
        // 存在**的壳把它们接回来 —— 壳的裸样式(flex column / height:100% / overflow:hidden)
        // 恰好就是面板内容器要的形,不必再覆盖。
        const scope = el("div", { className: "v-board ze-scope" }, [form]);
        // 158 G3 / Q12(WD-15):放大框里没有保存 / 取消钮,怎么存怎么退全靠猜 ⇒ 底下一行小字说清。
        // ⛔ 不加钮(用户拍的是小字那档):出口仍只有保存 / 不要两条。
        const panel = el("div", { className: "ze-panel" }, [scope, el("p", { className: "ze-hint", textContent: t("board.zoomHint") })]);
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", t("board.zoomEdit"));
        overlay = el("div", { className: "cm-overlay ze-overlay" }, [panel]);
        // Tab 圈在面板里(§3.5 那条违例:此前焦点今天出不去是巧合 —— Tab 在正文框里被清单缩进接管)。
        // 先看 defaultPrevented:清单行上的 Tab 已被缩进吃掉,那一下不该再挪焦点。
        panel.addEventListener("keydown", (e) => {
          if (!e.defaultPrevented) trapTab(panel, e);
        });
        document.body.append(overlay);
        input.style.height = ""; // 让位给面板的 flex(见上面 input 监听那条)
        input.style.overflowY = "";
        input.focus();
        input.setSelectionRange(at[0], at[1]);
      }

      // W5 A17(WD-18):Tab 走开 = 离开 = 照「离开就保存」存下并收起(此前框开着、字留着、屏上不说,切了视图才悄悄存上)。
      // 与点别处同一条 commit:没改 = 只收起、不打后端(⛔ 不多落一版);改了 = 落一版(就是回车 / 点别处那一版)。
      // 等焦点真落定了(下一拍)再判:还在表单里(⤢ / 删图 ×)、进了卫星层(看大图 / 菜单 / 留言浮层)、
      // relatedTarget 为空(切走窗口 / 点不可聚焦处 —— 后者归 onDown)都不算。放大态面板圈着 Tab,走不出去。
      // Tab 走出整页(最后一张、后面再没有能停的)时 relatedTarget 也是空的 —— 靠「刚按过 Tab」认出来。
      let tabAt = -Infinity;
      form.addEventListener("keydown", (e) => {
        if (isTabKey(e)) tabAt = performance.now();
      });
      form.addEventListener("focusout", (e) => {
        const to = e.relatedTarget as HTMLElement | null;
        if (to === null ? performance.now() - tabAt > 300 : form.contains(to) || to.closest(SATELLITE_LAYERS)) return;
        setTimeout(() => {
          if (!form.isConnected || saving) return;
          const a = document.activeElement;
          if (a instanceof HTMLElement && (form.contains(a) || a.closest(SATELLITE_LAYERS))) return;
          commit();
        }, 0);
      });
      c.replaceChildren(form);
      input.focus();
      // Q15(桌面新撞-3):光标放末尾、不全选 —— 此前整段是选中的,第一下按键就把标题整段换掉。
      input.setSelectionRange(input.value.length, input.value.length);
      // 按 E 之后、框出来之前打的字(holdTypeAhead 收着的)续在光标处;走 input 事件让「改过了」与长高照常算。
      const ahead = takeTypeAhead();
      if (ahead) {
        input.setRangeText(ahead, input.selectionStart, input.selectionEnd, "end");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      autoGrow(input);
    }

    // Read-only thumbnail strip — both board & trash cards show their images (editing them
    // lives in board-mode openEdit). Appended last so it sits below the meta/tags.
    c.append(imageStrip(item.id, { editable: false, onMetas }).root);

    return c;
  }

  /** 「展开 / 收起」那枚钮(704):只长在**真被夹住**的卡上。点一下翻 `.clamped` 并记进
   *  `expanded` —— 记了下一发 load() 重画才不会把它又合上(重画在同一个 mount 里)。 */
  function foldToggle(id: string, body: HTMLElement): HTMLButtonElement {
    const b = el("button", { className: "fold-toggle", type: "button" });
    const paint = (): void => {
      const folded = body.classList.contains("clamped");
      // 箭头与筛选条父子折叠那枚同一套语言(filter-bar.ts 的 ▸/▾);这里是纵向折叠,
      // 故用 ▾(下面还有)/ ▴(收回去)。字在字典里,箭头不是文案、不进字典。
      b.textContent = folded ? `${t("board.unfold")} ▾` : `${t("board.fold")} ▴`;
      b.setAttribute("aria-expanded", String(!folded));
    };
    b.addEventListener("click", () => {
      if (body.classList.toggle("clamped")) expanded.delete(id);
      else expanded.add(id);
      paint();
    });
    paint();
    return b;
  }

  /** 落 DOM 之后把「谁真被夹住了」定下来:没溢出的摘掉夹子(与没有本功能时逐字同形),
   *  真溢出的补一枚钮;已在 `expanded` 里的摊开、但**钮照留**(否则摊开过的卡就再也收不回)。
   *
   *  ⭐ **读写分两趟**:逐张「量一下改一下」会把一列 73 张卡变成 73 次强制重排;先把两个读数
   *  一次性读完(一次布局),再统一写。⚠ 上限那个数(8 行)住 board.css,这里只问「夹到东西
   *  没有」「夹到的是不是一枚还没勾的方框」—— 界面字号四档是整窗缩放,行数由 em 保证,JS 不必知道。 */
  function settleFolds(): void {
    const bodies = [...board.querySelectorAll<HTMLElement>(".ttitle.clamped")];
    const read = bodies.map((p) => ({
      over: p.scrollHeight > p.clientHeight + FOLD_SLACK_PX,
      boxCut: hasBoxBelowFold(p),
    }));
    bodies.forEach((p, i) => {
      // 认卡走 histFor(三种 mode 都挂;taskId 只挂看板态,回收站卡 159 起也要折)。
      const id = p.closest<HTMLElement>(".tcard")?.dataset.histFor;
      if (!read[i].over || id === undefined) {
        p.classList.remove("clamped"); // 夹子什么也没夹到:摘掉,别留一个假状态在 DOM 上
        return;
      }
      // 褶子下面压着还没勾的框 ⇒ 摊开,且**记进 expanded**:勾选是不可变性的唯一例外(0039),
      // 而勾完最后一个框的那一下(toggleBox 落盘后那发 load())判据会翻面 —— 不记的话这张卡
      // 会在手指底下自己合上。
      if (read[i].boxCut) expanded.add(id);
      if (expanded.has(id)) p.classList.remove("clamped");
      p.after(foldToggle(id, p));
    });
  }

  function renderBoard(items: TaskItem[]): void {
    board.className = "board-wrap";
    // 复制看板(页头「⋯」里那一项): copies every non-empty column as Markdown. Built from the currently
    // shown tasks, so it respects the active filters (标签 and/or 文本).
    boardMd = boardMarkdown(cols, items, doneId());
    const sections = cols.map((col) => {
      const status = col.id;
      const name = columnName(col);
      const inCol = dueOnly
        ? sortByDue(items.filter((t) => t.status === status))
        : sortColumn(items.filter((t) => t.status === status), boardSort);
      const head = el("div", { className: "col-head" }, [
        // title 挂全名:列窄时列名是单行截断(board.css .col-name),悬停才看得到全称。
        el("span", { className: "col-name", textContent: name, title: name }),
        el("span", { className: "col-count", textContent: String(inCol.length) }),
      ]);
      // 复制本列为 Markdown (only when the column has cards).
      if (inCol.length > 0) head.append(copyButton(columnMarkdown(name, status === doneId(), inCol), "col-copy", t("board.copy")));
      // 一键全部归档(仅 已完成 列、非空时):干完的活整列入成就册。非破坏、可逐条取消
      // 归档,但批量动一整列仍值得一次行内确认(swap 在列头的 slot 里,不弹窗)。
      if (status === doneId() && inCol.length > 0) {
        const slot = el("span", { className: "seal-all-slot" });
        // 两份标签常驻 DOM、由 container query 二选一显形(与 header 那排 .hbtn 的
        // 「窄窗缩成字母」同一套手法):窄列下「全部」让位给列名,钮仍在原地。
        const sealBtn = btn("", "ghost", () => {
          // 列头让位:常态那几件(名 / 计数 / 复制)退场,问句与两枚钮独占这一行,
          // 否则窄列下确认钮会被裁成一个字(board.css .col-head.confirming)。
          // ⭐ 只需在进确认时加 —— 取消 / 点别处 / 确认三条退出路径都走 load() 全量
          // 重画,列头连同这枚 class 一起重建,不必手动摘。
          head.classList.add("confirming");
          // n 按「已完成」列的**全部**卡说(seal_done_tasks 归的是全部,筛选下列头只画出一部分)。
          const ids = [...doneIds];
          confirmInline(slot, t("board.sealAllQ", { n: ids.length }), t("board.seal"), () => void sealAllDone(ids));
        });
        sealBtn.title = t("board.sealAll"); // 窄列显短标签时,悬停仍说得出全称
        sealBtn.append(
          el("span", { className: "lbl-long", textContent: t("board.sealAll") }),
          el("span", { className: "lbl-short", textContent: t("board.sealAllShort") }),
        );
        slot.append(sealBtn);
        head.append(slot);
      }
      const body = el("div", { className: "col-body" });
      // 空列不放占位符:col-body 是 flex:1 自撑满、仍是有效拖放目标,列头的「0」计数已说明空。
      if (inCol.length > 0) body.append(...inCol.map((t) => card(t, "board")));

      // 一节列身。⭐ **class 与 data-col 两份是有意的**:`class` 那份是 CSS 与 e2e 选择器
      // 的老口径(`.col.done` 之类),而**查列一律走 `data-col`** —— 自定义列的 id 是 ULID,
      // 可能以数字开头,`.col.01J…` 是**非法 CSS 选择器**(querySelector 当场抛)。
      // ⛔ 别把机器读的那一份挪回 class。
      // ⚠ 这里只有活列(`boardColumns`);删掉的列里还扣着的卡在收容区(plan §3a),那边只出不进。
      const sec = el("section", { className: `col ${status}` }, [head, body]);
      sec.dataset.col = status;

      // The column is a drop target: a drop reorders within this column, or —
      // from another column — moves the task here AND inserts it at the dropped spot.
      // Under a topic filter the DOM is only the visible subset, so the drop routes to
      // reorder_task_visible (merged server-side); see the drop handler below.
      // Hover highlight is managed centrally here (clear all, set the one under the
      // pointer) rather than via dragleave — dragleave fires as the pointer crosses
      // child cards, and toggling the class off/on each time made the column blink.
      // ⭐ 落点是**整根列**(列头 + 列体),不只列体(666):此前列头那条 35px 的带子不接放,
      // 往一列的「上面」拖过去松手就退回。列头上松手 = 指针在第一张卡之上 ⇒ dragAfterElement
      // 给出首卡,自然落到列首;高亮 / 插入线 / 自动滚仍画在列体上。列与列之间那 16px 的缝
      // 刻意仍不接:那儿松手退回是「没放进任何一列」,不是误伤。
      onDragTarget(sec, (e) => {
        if (!dragging) return;
        e.preventDefault();
        clearDropHovers();
        body.classList.add("drop-hover");
        placeDropLine(body, e.clientY);
        pumpAutoScroll(body, e); // 贴着列的上下边就自动滚(长列里拖到另一头的唯一路)
      });
      sec.addEventListener("drop", (e) => {
        e.preventDefault();
        const d = dragging;
        dragging = null;
        stopAutoScroll();
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
        // 158 G1 / A3(WD-04):跨列拖放与菜单 / `]` `[` 移列同一套回执 + 撤销(此前拖着挪一声不吭,
        // 拖进「已完成」也是)。撤销回**原位**:先记下源列此刻的序(含本卡),同 moveTo。
        const srcOrder =
          d.from === status
            ? []
            : [...(board.querySelector(`.col[data-col="${d.from}"] .col-body`)?.querySelectorAll<HTMLElement>(".tcard") ?? [])].map(
                (x) => x.dataset.taskId!,
              );
        const dropped = board.querySelector<HTMLElement>(`[data-task-id="${d.id}"]`);
        if (dropped) body.insertBefore(dropped, after);
        // 跨列才改列计数:源列 −1、目标列 +1(同列内重排成员数不变,故按 from≠target 判)。
        if (d.from !== status) {
          bumpColCount(d.from, -1);
          bumpColCount(status, 1);
        }
        const persist = filtered ? reorderVisible : reorder;
        void persist(d.id, d.from, status, base, ordered).then((ok) => {
          if (d.from === status) return; // 列内重排不是「挪到哪儿去了」,不说话
          undoable(
            ok,
            t("board.undoMoved", { col: name }),
            () => (busy ? Promise.resolve(false) : persist(d.id, status, d.from, srcOrder.filter((x) => x !== d.id), srcOrder)),
            goSeeIfHidden(d.id), // Q1:拖着自动滚到列另一头松手,落点也可能已滚出视野
          );
        });
      });
      return sec;
    });

    // The 归档 drop strip below the columns — only a card from this board's 完成列 may land here.
    // 纯分类看板(没有完成列)没有归档 ⇒ 不摆这一条(它本来也永远不会亮)。
    const doneCol = cols.find((c) => c.id === doneId());
    const zone = el("div", { className: "archive-zone" }, [
      el("span", { className: "az-label", textContent: doneCol ? t("board.archiveZoneHint", { col: columnName(doneCol) }) : "" }),
    ]);
    onDragTarget(zone, (e) => {
      if (dragging && dragging.from === doneId()) {
        e.preventDefault();
        clearDropHovers();
        zone.classList.add("drop-hover");
        detachDropLine(); // a column line shouldn't linger while hovering 归档
        stopAutoScroll(); // 已离开列体:别让上一节列继续自己滚(回到列上由它的 dragover 重启)
      }
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-hover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drop-hover");
      const d = dragging;
      dragging = null;
      stopAutoScroll();
      if (!d || d.from !== doneId()) return;
      // 真归档(成就册),不再是丢回收站——「归档」一词自此只有一个意思(概念隔离)。
      // 手势即回执:松手即离场,不等重载才消失;失败由 sealOne 内的 load() 复原。
      board.querySelector(`[data-task-id="${d.id}"]`)?.remove();
      bumpColCount(d.from, -1); // 卡即刻离场,计数同帧扣掉,别等 sealOne 内的 load()
      sealOne(d.id);
    });

    // 只有一列的看板(书单这类纯分类)限宽居中,读起来像一张清单(用户 2026-11-11 拍)。
    const cols_wrap = el("div", { className: cols.length === 1 ? "cols single" : "cols" }, sections);
    if (doneCol) board.replaceChildren(cols_wrap, zone);
    else board.replaceChildren(cols_wrap);
    settleFolds(); // ⚠ 必须在还原滚动位**之前**:下面那几行还的是**夹后**几何里的位置
    // 还原各列滚动位(记录见 load() 重画定局处;列变短时 scrollTop 由浏览器自钳位)。
    for (const sec of board.querySelectorAll<HTMLElement>(".col")) {
      const colBody = sec.querySelector<HTMLElement>(".col-body");
      const id = sec.dataset.col;
      if (colBody && id) colBody.scrollTop = colScroll.get(id) ?? 0;
    }
  }

  function renderTrash(items: TaskItem[], removed: RemovedGroup[]): void {
    if (items.length === 0 && removed.length === 0) {
      renderCentered(
        el("div", { className: "big", textContent: t("board.trashEmpty") }),
        el("div", { textContent: t("board.trashEmptyHint") }),
      );
      return;
    }
    board.className = "trash";
    // 清空连这一页的已删配图一起销毁(用户面 149):确认句把张数说出来。W3 159 / A9 + A19(WD-10 / WD-23):
    // 确认走两个回收站共用的 trash-purge —— 此前这里左边一句问话 +「取消」+ 红实心「全部删除」(确认跳到
    // 左边、取消在前),与随记回收站措辞、钮序、位置都不同,也不是规范要的全宽。
    const { button, panel } = trashPurgeControl({
      which: "tasks",
      count: () => ({ items: items.length, images: removedImageCount(removed) }),
      claimConfirm: (off) => {
        if (off === null) confirmOff = null;
        else {
          disarmConfirm();
          confirmOff = off;
        }
      },
      onYes: () => void purgeAll(),
    });
    const bar = el("div", { className: "trash-bar" }, [
      // 只剩已删配图时不写「0 条已删除的任务」(那一节自带标题)。
      el("span", { className: "grow", textContent: items.length === 0 ? "" : t("board.trashCount", { n: items.length }) }),
      button,
    ]);
    const list = el("div", { className: "trash-list" }, items.map((t) => card(t, "trash")));
    if (removed.length === 0) board.replaceChildren(bar, panel, list);
    else board.replaceChildren(bar, panel, list, trashImagesSection(removed));
    settleFolds(); // 回收站卡也折(A16);画完才量得出
  }

  // 回收站里的「已删配图」一节(用户面 149):行动作走本视图的单键控制器,键与回收站卡片
  // 同概念同键(还原 U / 彻底删除 D);确认态交本 mount 的 confirmOff 统一收;写失败走横幅。
  function trashImagesSection(groups: RemovedGroup[]): HTMLElement {
    return removedImagesSection(groups, {
      hk,
      keys: { restore: BOARD_TRASH_KEYS.restore, deleteForever: BOARD_TRASH_KEYS.deleteForever },
      claimConfirm: (off) => {
        if (off === null) confirmOff = null;
        else {
          disarmConfirm();
          confirmOff = off;
        }
      },
      onChanged: () => void load(),
      onError: (msg) => showOpError(msg),
      buttons: { yes: "act primary", no: "act ghost" },
    });
  }

  // 归档册:干完的活按**完成日**分组成时间轴(0030 决定 A:完成时刻优先,老卡无 done_at
  // 时回落归档日 sealed_at;同灵感 ㊳ 的按天分组,共享 dayKey/dayLabel)。批量归档不再把
  // 一周的活压成归档那天——答得准「什么时候干完」。只读 + 每卡一个「取消归档」;无删除入口。
  function renderSealed(allItems: TaskItem[], allDoneOnBoard: TaskItem[]): void {
    // 0043(用户拍 ⑦):成就合一本,顶上可按看板筛。筛的是看板、不是列:来处按卡所在列的归属认(删掉的看板也算一块)。
    // 902 F8 / R4(用户拍板,两端同形;手机 panes.ts::renderSealed):**活看板 ≥ 2 块**时那排筛选恒出现 ——
    // 「全部看板」+ 当前看板(恒在,哪怕它没有归档)+ 其他有内容的看板;进册恒选当前看板(toggleSealed),它没有归档就是
    // 那句「这块看板还没有归档的卡片」。此前要「不止一块看板有东西可看」才出,当前看板没归档时预选被改回「全部」——
    // 从 B 看板点进归档册,看到的是 A 看板的卡,屏上不说为什么。
    // 只有一块活看板的库照旧:成就来自 ≥ 2 块看板(另一块已删)才出那排,否则不出(一枚「全部」是噪音)。
    // ⛔ 活看板只有一块时别把它硬塞进那排:已删的看板也在 `boards` 里,会凭空挂上「任务」。
    const fromOf = (x: TaskItem): string | null => boardOfCol(x.status)?.id ?? null;
    const both = [...allItems, ...allDoneOnBoard];
    const multi = liveBoards(boards).length >= 2;
    const homeId = multi && !sealedNoHome ? (cur?.id ?? null) : null;
    const pillBoards = boards.filter((b) => b.id === homeId || both.some((x) => fromOf(x) === b.id));
    const tagged = multi || pillBoards.length >= 2;
    sealedTagged = tagged; // 来处名小签:筛选排在就挂(筛着单块看板时也挂,同手机)
    if (!tagged || !pillBoards.some((b) => b.id === sealedBoard)) sealedBoard = null;
    const items = sealedBoard === null ? allItems : allItems.filter((x) => fromOf(x) === sealedBoard);
    const doneOnBoard = sealedBoard === null ? allDoneOnBoard : allDoneOnBoard.filter((x) => fromOf(x) === sealedBoard);
    const pills: HTMLElement | null = !tagged
      ? null
      : el("div", { className: "sealed-boards" }, [
            sealedPill(t("boards.sealedAll"), null),
            ...pillBoards.map((b) => sealedPill(boardName(b), b.id)),
          ]);
    function sealedPill(label: string, id: string | null): HTMLElement {
      const p = el("button", { className: "tf-pill" + (sealedBoard === id ? " active" : ""), type: "button", textContent: label });
      p.setAttribute("aria-pressed", String(sealedBoard === id));
      p.addEventListener("click", () => {
        sealedBoard = id;
        void load();
      });
      return p;
    }
    // 整本都空:只有一块活看板的库照旧是整页那句「还没有归档的卡片」+ 怎么归档;多看板的库筛选排照出(下面),
    // 空的那句落在列表位上。
    if (allItems.length === 0 && !multi) {
      // 说法点名**这块看板**的完成列(R4:别写死「已完成」);这块没有完成列就泛说「有完成列的看板」。
      const doneCol = cols.find((c) => c.id === doneId());
      renderCentered(
        el("div", { className: "big", textContent: t("board.sealedEmpty") }),
        el("div", {
          textContent: doneCol ? t("board.sealedEmptyHint", { col: columnName(doneCol) }) : t("boards.sealedEmptyHintNoDone"),
        }),
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
    // ⭐ 158 G2 / A6(WD-09)查清的:错的是这一行,不是卡 —— 它此前只数**归档册里**的,取消归档一条
    // 卡回到「已完成」列、仍是本周做完的,数字却减了。「完成」与「归档没归档」是两根轴 ⇒ 看板「已完成」
    // 列里那些也算进来(done_at 为 null 的老卡只进累计、不进本周)。归档 / 取消归档从此不动这两个数。
    const monday = startOfWeek();
    const week =
      items.filter((t) => new Date(groupTs(t)) >= monday).length +
      doneOnBoard.filter((t) => t.done_at !== null && new Date(t.done_at) >= monday).length;
    const total = items.length + doneOnBoard.length;
    // W3 159 / A21(WD-26):这两个数含看板「已完成」列里还没归档的那几张(口径如上,⛔ 别改回只数册子里的),
    // 而下面只列册子里的 ⇒ 页头写「累计 5」、下面只有 3 张,对不上又不说。补半句交代那几张在哪。
    // 0043:那几张散在哪些完成列里 —— 只在一列时点名(「已完成」),散在几块看板的完成列里就泛说。
    const doneHomes = [...new Set(doneOnBoard.map((x) => x.status))];
    const onBoardNote =
      doneOnBoard.length === 0
        ? ""
        : doneHomes.length === 1 && anyColName(doneHomes[0]) !== null
          ? t("board.sealedStatsOnBoard", { n: doneOnBoard.length, col: anyColName(doneHomes[0])! })
          : t("boards.sealedStatsOnBoards", { n: doneOnBoard.length });
    const stats = t("board.sealedStats", { week, total });
    const bar = el("div", { className: "trash-bar sealed-stats" }, [el("span", { className: "grow", textContent: stats + onBoardNote })]);
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
    // 筛着某块看板而它没有归档 = 「这块看板还没有归档的卡片」;在「全部看板」上还是空的 = 整本都空,说整本那句(同手机)。
    if (items.length === 0) {
      list.append(el("p", { className: "sealed-none", textContent: sealedBoard === null ? t("board.sealedEmpty") : t("boards.sealedNoneHere") }));
    }
    board.replaceChildren(...(pills ? [pills] : []), bar, list);
  }

  // 收容区(multiboard-plan §3a):已删除的看板 / 列里还扣着的活卡,**按原看板 / 列分组、保留来处名**。
  // 只读、只出不进(卡上只有「挪到看板 ▸」与删除)。清空了就只剩一句「这里空了」—— 侧栏那行同时消失。
  function renderHolding(active: TaskItem[]): void {
    const groups = holdingColumns(allCols)
      .map((c) => ({ col: c, items: active.filter((x) => x.status === c.id) }))
      .filter((g) => g.items.length > 0);
    if (groups.length === 0) {
      renderCentered(
        el("div", { className: "big", textContent: t("boards.holdingEmpty") }),
        el("div", { textContent: t("boards.holdingEmptyHint") }),
      );
      return;
    }
    board.className = "trash holding-view";
    const bar = el("div", { className: "trash-bar" }, [
      el("span", { className: "grow", textContent: t("boards.holdingBar", { n: groups.reduce((n, g) => n + g.items.length, 0) }) }),
    ]);
    const list = el("div", { className: "trash-list" });
    for (const g of groups) {
      const home = g.col.board_id ? boards.find((b) => b.id === g.col.board_id) : undefined;
      const where = home ? t("boards.holdingFrom", { board: boardName(home), col: columnName(g.col) }) : columnName(g.col);
      const why = g.col.board_deleted ? t("boards.holdingBoardGone") : t("boards.holdingColGone");
      list.append(el("div", { className: "tl-date holding-from" }, [where, el("span", { className: "holding-why", textContent: why })]));
      for (const x of g.items) list.append(card(x, "holding"));
    }
    board.replaceChildren(bar, list);
  }

  /** 种子列 id → 空看板上那一句「这一列放什么」(898 G3)。第一列(待办)不在表里:那里已经是「怎么开始」。 */
  const SEED_COL_HINT: Record<string, (() => string) | undefined> = {
    doing: () => t("board.colHintDoing"),
    confirming: () => t("board.colHintConfirming"),
    done: () => t("board.colHintDone"),
  };

  function renderCentered(...children: Node[]): void {
    board.className = "centered";
    board.replaceChildren(el("div", { className: "center" }, children));
  }

  /** 一张卡都没有的看板(W3 159 / Q12,WD-40):照常画出各列(列头、计数 0、可拖放),那句「怎么开始」
   *  落在第一列的列体里 —— 此前是整页居中一句话、一根列都没有。没有可复制的东西:复制钮收起。 */
  /** `sealedN` = **这块看板**的成就有几张(165 / W5 Q15,WD-34 前半:唯一那张归档后看板变回「还没有卡片」,只有页头
   *  「归档 1」对得上 —— 像是那张没了;有归档的补一句它在哪)。
   *  R3(多看板优化,用户 2026-11-12 拍):这几句只说**这块看板**的事 —— 归档数只数这块的成就,这块没有完成列就不提归档;
   *  「转待办」那半句只在默认看板上说(转待办落默认看板),别的看板说「放进看板」;放不进卡(落点 ⊥)就只说为什么。 */
  function renderEmptyBoard(sealedN: number): void {
    renderBoard([]);
    boardMd = null; // 空看板没东西可抄:菜单里不出「复制看板」
    const first = board.querySelector<HTMLElement>(".col .col-body");
    if (!first || cur === null) return; // 一根列都没有(活看板恒至少一列,不该发生):就不放提示
    const hint =
      cur.landing === null ? t("board.newTaskNoLanding") : cur.is_default ? t("board.emptyHint") : t("boards.emptyHintOther");
    // 898 G3:再说一句「卡片能拖」。⚠ 「做完」靠的是这块看板的**完成列角色**(core 解析的 `cur.done`,人能在「管理看板」里
    // 改指、也能取消),不是「最后一列」也不是某个列名 ⇒ 句子里点名的是眼前那一列此刻的名字;没有完成列就只说能拖。
    // 放不进卡(落点 ⊥)或只有一列时不说 —— 没有东西可拖 / 没有别的列。
    const doneCol = cur.done === null ? undefined : cols.find((c) => c.id === cur!.done);
    const drag =
      cur.landing === null || cols.length < 2
        ? null
        : doneCol
          ? t("board.emptyDrag", { col: columnName(doneCol) })
          : t("board.emptyDragNoDone");
    first.append(
      el("div", { className: "col-empty" }, [
        el("p", { className: "col-empty-big", textContent: t("board.empty") }),
        el("p", { textContent: hint }),
        ...(drag ? [el("p", { className: "col-empty-drag", textContent: drag })] : []),
        ...(sealedN > 0 && cur.done !== null
          ? [el("p", { className: "col-empty-sealed", textContent: t("board.emptySealed", { n: sealedN }) })]
          : []),
      ]),
    );
    // 898 G3 后半:种子那三列各一句「这一列放什么」。身份 = 种子列 id ∧ 名字没改过(`title_overridden === false`,
    // 同 columnName 查本端字典的那个判据)⇒ 改过名的列不说(那已经是人自己的意思);「已完成」那句还要它此刻真是完成列。
    // ⛔ 只在**整块看板一张卡都没有**时说(这里):有卡之后空列照旧不放占位符(renderBoard 里那条注释的决定没动)。
    for (const c of cols) {
      const say = c.title_overridden ? undefined : SEED_COL_HINT[c.id];
      if (!say || c === cols[0] || (c.id === "done" && cur.done !== c.id)) continue;
      board
        .querySelector<HTMLElement>(`.col[data-col="${c.id}"] .col-body`)
        ?.append(el("div", { className: "col-empty col-empty-role" }, [el("p", { textContent: say() })]));
    }
  }

  function renderFilteredEmpty(): void {
    // 文本过滤(可能叠着标签)筛空:提示词本身,别让用户以为看板空了。
    const q = filter.text.trim();
    // 157 G3(WD-19):标题之外还开着的维,补在提示前面点名(同随记页)。
    const hint = (said: "text" | "topics" | "kind", h: string): string => {
      const note = otherLayersNote(filter, allTopics, timeFilter, said, "created");
      return note ? `${note}${h}` : h;
    };
    if (q !== "") {
      renderCentered(
        el("div", { className: "big", textContent: t("board.noMatch", { q }) }),
        el("div", { textContent: hint("text", t("board.noMatchHint")) }),
      );
      return;
    }
    // 筛着「到期」又叠了别的维度而筛空(单独筛到期不可能空 —— 钮只在有内容时才在):
    // 说清是这两把尺的交集为空,别让人以为到期那些卡没了(502)。
    if (dueOnly) {
      renderCentered(
        el("div", { className: "big", textContent: t("board.noDueMatch") }),
        el("div", { textContent: t("board.noDueMatchHint") }),
      );
      return;
    }
    // 余下三维**按「哪一维最具体」排**:标签 → 类型 → 时间。⚠ 排到最后那一档不必再判
    // `timeFilter !== "all"`:调用方只在 `visible` 非空而 `shown` 空时进来 ⇒ 至少一维在筛,
    // 前面几维都已排除就只可能是时间。
    //
    // ⛔ **别把类型那一档去掉**(652,用户报的):`selectedTopicLabels` 只认标签维,光筛
    // 类型时它给空数组 ⇒ 落到标签那句就是「「」下没有任务」。461 只给时间那一维补了出口
    // (判据写成 `kind === "all" && topics.length === 0 && time !== "all"`),类型这一维照旧
    // 漏在标签那句里。⭐ 四档全的那份在 `android/src/main.ts::filteredEmptyHtml`。
    if (filter.topics.length > 0) {
      const label = selectedTopicLabels(filter, allTopics).join(t("board.listSeparator"));
      renderCentered(
        el("div", { className: "big", textContent: t("board.noTasksUnder", { label }) }),
        el("div", { textContent: hint("topics", t("board.noTasksUnderHint")) }),
      );
      return;
    }
    if (filter.kind !== "all") {
      renderCentered(
        el("div", { className: "big", textContent: t("board.noTasksInKind", { kind: filter.kind }) }),
        el("div", { textContent: hint("kind", t("board.noTasksInKindHint")) }),
      );
      return;
    }
    renderCentered(
      el("div", { className: "big", textContent: t("board.noTasksInTime") }),
      el("div", { textContent: t("board.noTasksInTimeHint") }),
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
    // W3(多看板优化第二波):回收站 / 归档册的整张表只在**那一页**才拉;顶栏两个数走计数命令(trash_counts /
    // sealed_counts_by_board)。`view` = 这一发按哪一页取的数 —— 取完页已经换了(reselect 排着的那发还没起)就按新页重取,
    // ⛔ 别拿上一页的数据画这一页(codex 第二波第 4 条)。
    const view = boardView;
    try {
      const [active, topics, freshCols, freshBoards, , cmCounts, trashCounts, sealedCounts, trashLists, sealedList] = await Promise.all([
        invoke<TaskItem[]>("list_tasks"),
        invoke<TopicOpt[]>("list_topics"),
        // 看板列(B-f 第 1 段):同样**并发**取。⚠ 它与 list_tasks 是两次独立读,中间那一
        // 瞬对端可能刚删掉一列 —— 无害:两份都是快照,最坏是这一帧少画/多画一列的收容区,
        // 下一次 load 就对上了。⛔ 别为它去开一条「一次读两样」的合并命令(那要在 core 里
        // 造第二份口径)。
        loadBoardColumns(),
        // 看板(0043):角色 / 默认 / 死活都是 core 解析好的;与列同理并发取、各是一份快照。
        loadBoards(),
        // 设备名册(0033 署名):与列表**并发**取,不给渲染加一跳延迟。
        loadIdentity(mountSpace),
        // 留言计数(0035 徽章):同样并发;列表另走分页(§4.14.2 第 4 条)。
        loadCommentCounts(mountSpace),
        // 顶栏「回收站 N」「归档 N」(W3):两个计数命令,与列表是独立的读 —— ⛔ 别要求它们在并发写下与页里的列表严格相等。
        loadTrashCounts(),
        loadSealedCounts(),
        // 回收站页:进了回收站的卡 + 回收站里的已删配图(用户面 149:宿主 stage 属任务的那些归这一页)。
        view === "trash"
          ? Promise.all([invoke<TaskItem[]>("list_archived_tasks"), listRemovedImages("tasks")])
          : null,
        // 归档册页:成就全表。
        view === "sealed" ? invoke<TaskItem[]>("list_sealed_tasks") : null,
      ]);
      if (seq !== loadSeq) return; // 有更晚的 load 已在途:旧响应不落 DOM(否则盖新画/拆脉冲)
      if (boardView !== view) {
        void load(); // 取数途中换了页:这一份是上一页的,按新页重取
        return;
      }
      // focus 只由**确认最新**的这一发消费(codex 三审 H1):放在 seq 守卫之后取走——陈旧的
      // load 直接 return、不碰 focusId,跳转请求因此永远交给真正会渲染的那一发,不会丢。
      const focus = focusId;
      focusId = null;
      allTopics = topics;
      allCols = freshCols;
      boards = freshBoards;
      doneCols = doneColumnSet(boards);
      // 跨视图跳到一张任务卡(搜索 / 深链接 / 「去看看」):它在别的看板上就先切过去,在收容区就落收容区
      // —— 否则跳过来那块看板上没有它,白跳(0043)。只认看板态的跳转;回收站 / 归档册的跳转不动看板。
      if (focus !== null && boardView === "board") {
        const hit = active.find((x) => x.id === focus);
        if (hit) {
          if (heldAt(hit.status)) boardView = "holding";
          else {
            const home = boardOfCol(hit.status);
            if (home && !home.deleted) setCurrentBoard(home.id, mountSpace);
          }
        }
      }
      cur = currentBoard(boards, mountSpace);
      // R5:眼前这块不是筛选选定时那块 ⇒ 标签 / 类型 / 时间筛选与「只看到期」回到「所有」(判据住 SpaceMemo 头注)。
      const switched = memo.board !== null && memo.board !== cur.id;
      if (switched) {
        filter.kind = "all";
        filter.topics = [];
        timeFilter = "all";
        dueOnly = false;
      }
      memo.board = cur.id;
      cols = boardColumns(allCols, cur.id);
      shareBoardData({ space: mountSpace, boards, cols: allCols }); // 侧栏名单与收容计数跟着这一份

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
        trashCounts,
        sealedCounts,
        trashLists,
        sealedList,
        topics,
        // 列进指纹:别台设备给列改了名 / 调了顺序 / 删了一列,任务数据一个字节没变、
        // 变的只有列头与列序 —— 不进指纹的话 refocus 刷新会在这一格短路掉(同 cmCounts)。
        // 0043:全部列(收容区 / 来处名)、看板(名字 / 角色)与在看哪块、归档册筛哪块同理。
        allCols,
        boards,
        cur.id,
        sealedBoard,
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
      // 716:编辑中不重画 —— 回窗 / 远端落地(refocus)那一发整轮跳过,编辑态收场(保存 / Esc /
      // 点别处都走 load())时以那时的真相重取重画。⚠ 只跳 refocus 形:用户自己发起的 load
      // (删了别的卡 / 拖了别的卡)照旧先落盘本编辑再画(下面那段 P1 #9b)。⚠ 放在 lastSig
      // 之前:跳过的那发没画,指纹不能记成「画过了」。
      if (refocus === true && activeEditFlush) return;
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
      // 回收站 / 归档册的列表只在那一页才有 ⇒ 别的页上,开着留言的那条已不在眼前就收(宿主离开了这一页)。
      refreshOpenComments(mountSpace, [...active, ...(trashLists?.[0] ?? []), ...(sealedList ?? [])].map((t) => t.id));
      disarmConfirm(); // 卡片将被整批替换:在场确认的文档级监听一并收走
      if (activeEditCleanup) {
        activeEditCleanup();
        activeEditCleanup = null;
      }
      // Cleared here; renderBoard sets it again. Trash/empty states have nothing to copy.
      boardMd = null;

      // The toggles always reflect the live counts.
      // 顶栏计数 = 条目 + 已删配图(只剩几张图时钮上不能写 0)。
      // 158 G3 / Q13(WD-33):页头随视图改名(此前归档页 / 回收站页都还写着「任务看板」,看不出在哪);
      // 进了归档 / 回收站,那枚开关变成「← 看板」返回钮 —— 它旁边的数字是归档 / 回收站的条数,
      // 挂在「看板」两个字后面读成「看板上有几张」,这时藏起来(页里那一行自己会说几条)。
      // 0043:看板态的页头 = 这块看板的名字(侧栏里点的那块);收容区一个固定的名。
      // D11:页头里的字与显隐**变了才写**(setText / setHidden)—— 原样再写一遍也会惊动页头的 MutationObserver,
      // 每次 load 白量一趟 fitHeader。
      setText(
        boardTitle,
        boardView === "sealed"
          ? t("board.sealedTitle")
          : boardView === "trash"
            ? t("board.trashTitle")
            : boardView === "holding"
              ? t("boards.holdingTitle")
              : boardName(cur),
      );
      markActiveBoard(boardView === "holding" ? "holding" : boardView === "board" ? cur.id : null);
      setHidden(trashN, boardView === "trash");
      setHidden(sealN, boardView === "sealed");
      // 条目 + 已删配图**张数**(core 两格各自按同一谓词数好,⛔ 别再把配图组数 / 列表长度叠上去)。
      setText(trashN, String(trashCounts.tasks + trashCounts.task_images));
      trashToggle.classList.toggle("active", boardView === "trash");
      setText(trashToggle.firstChild!, boardView === "trash" ? t("board.backToBoard") : t("board.trashLbl"));
      // B12(用户 2026-11-12 拍):「归档 N」的 N 只数**这块看板**的成就(来处按卡所在列的归属认,同归档册那排筛选);
      // 这块看板没有完成列、也没有成就 ⇒ 这枚不显(纯分类看板上一枚恒 0 的「归档」是噪音)。快捷键 G 照旧开得了归档册。
      // 在归档册里它是「← 看板」返回钮,恒显。
      // W3:这块看板那一组的 n(core 按卡所在列的归属分组,含已删看板与 null 组 —— 那两种不属任何活看板,这里自然不取)。
      const sealedHere = sealedCounts.find((g) => g.board_id === cur!.id)?.n ?? 0;
      setHidden(sealToggle, boardView !== "sealed" && cur.done === null && sealedHere === 0);
      setText(sealN, String(sealedHere));
      sealToggle.classList.toggle("active", boardView === "sealed");
      setText(sealToggle.firstChild!, boardView === "sealed" ? t("board.backToBoard") : t("board.sealLbl"));

      // 新建卡片 only makes sense on the board, not in the 回收站/归档.
      setHidden(addTaskBtn, boardView !== "board");
      // R2:这块看板放不进卡(落点 ⊥:只剩完成列,多半是别的设备并发造出来的)⇒ 事前灰掉、title 说原因,
      // ⛔ 别等人打完字才被 core 拒。用 aria-disabled 不用 disabled:点了 / 按 N 还要说一句为什么(blockedCompose)。
      const noLanding = cur.landing === null;
      addTaskBtn.classList.toggle("blocked", noLanding);
      if (addTaskBtn.getAttribute("aria-disabled") !== (noLanding ? "true" : null)) {
        if (noLanding) addTaskBtn.setAttribute("aria-disabled", "true");
        else addTaskBtn.removeAttribute("aria-disabled");
      }
      addTaskBtn.title = noLanding ? t("board.newTaskNoLanding") : t("board.newTask");
      // 「⋯」(复制看板 / 管理看板)同理:回收站 / 归档册里根本没有列(B-f 第 2 段)。⚠ 看板态下「顺序」还要
      // 过一道「有没有卡」(下面算完 visible 再定;「管理看板」159 起空看板也在),这里先按视图收。
      setHidden(moreBtn, boardView !== "board");
      if (boardView !== "board") closeMoreMenu(); // 开着菜单时被带去了回收站 / 归档册(深链接、搜索落点):一并收
      // 排序轴同理只属看板(回收站按 archived_at、归档册按完成日,各有各的轴,500 不碰)。
      setHidden(sortBtn, boardView !== "board");
      // ⚠ paintSortBtn() 的调用挪到 paintDueSoon 之后(dueOnly title 要读它这一轮的
      // 终值——focusOnBoard 与「到期数归零」两条路都会在这之后才把 dueOnly 摆定,这里
      // 调会读到上一轮的旧值)。
      if (boardView !== "board") setHidden(dueSoonBtn, true); // 汇总也只属看板;计数在下面算
      if ((boardView !== "board" || noLanding) && !compose.hidden) setComposeOpen(false); // 框里的字留着(DOM 不动)

      // 搜索直达回收站/归档(P1 #8):目标在列表才脉冲+滚动;已离场(还原/取消归档的
      // 窄窗)静态落列表,不残留。
      if (boardView === "trash") {
        if (trashLists === null) throw new Error("trash view loaded without trash lists");
        const [archived, removed] = trashLists;
        filterRow.hidden = true;
        if (focus !== null && archived.some((t) => t.id === focus)) locateId = focus;
        renderTrash(archived, removed);
        if (focus !== null) board.querySelector(".just-located")?.scrollIntoView({ block: "center" });
        return;
      }
      if (boardView === "holding") {
        filterRow.hidden = true;
        if (focus !== null && active.some((t) => t.id === focus)) locateId = focus;
        renderHolding(active);
        if (focus !== null) board.querySelector(".just-located")?.scrollIntoView({ block: "center" });
        return;
      }
      if (boardView === "sealed") {
        if (sealedList === null) throw new Error("sealed view loaded without the sealed list");
        filterRow.hidden = true;
        if (focus !== null && sealedList.some((t) => t.id === focus)) {
          locateId = focus;
          sealedBoard = null; // 跳来定位那一张:回「全部看板」,免得它正好被筛掉、落空(同手机 sealedLocate)
        }
        renderSealed(sealedList, active.filter((t) => doneCols.has(t.status)));
        if (focus !== null) board.querySelector(".just-located")?.scrollIntoView({ block: "center" });
        return;
      }
      // 只显示 / 只计数「落在画出来的那几列里」的卡,列头计数因此永远与看板上的卡一致。
      // 0043 起 `cols` 只有**这块**看板的活列:别的看板上的卡、收容区里的卡(已删的看板 / 列,侧栏那一行进)
      // 在这里本来就不画 —— 那是归宿不同,不是吞卡。
      const visible = active.filter((t) => cols.some((c) => c.id === t.status));
      doneIds = visible.filter((t) => t.status === doneId()).map((t) => t.id);
      // 空看板照样摆出列和「管理列」(W3 159 / Q12,WD-40,用户拍板 —— **推翻用户面 85 ② 那半**):新空间
      // 的看板此前一根列都没有、也没有「管理列」,想先把列排好再往里放卡,无处下手。⇒ 空态也画列(renderEmptyBoard),
      // 「管理列」常在。「顺序」仍按数据藏(没有卡就没有可排的东西,85 ② 这半照旧);⛔ 不造开关(408-411)。
      setHidden(sortBtn, visible.length === 0);

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
      // W4 A25(同随记页那条,WD-27 / 新撞-5):空看板时这一行也占着位置、只是看不见(`.reserve`),
      // 记下第一张任务时它原地显出来,下面那几列不被整体往下推。
      filterRow.hidden = false;
      filterRow.classList.toggle("reserve", visible.length === 0);
      // 165 / W5 A21(WD-16):有标签就让标签那一行恒占着(filter-bar.css .keep-tags)—— 此前最后一张归档后两行筛选
      // 收成一行,四列整体上移 39px。
      // ⭐ B8(多看板优化,用户 2026-11-12 拍):「有标签」从「库里有」收窄到「**这块看板**上有卡打过标签」:
      // 书单这类从不打标签的看板上,标签那一行此前只剩一枚「过滤卡片…」单占一行;现在它并到时间那一行右端。
      // W3(第二波)起看板页不再拉成就全表 ⇒ 判据 = 这块看板的活卡有标签,**或这一趟打开看板以来它有过**(tagRowBoards):
      // A21 守的那几下(最后一张归档 / 转走唯一挂着的)照旧不跳;重开看板时按眼前的活卡重新判(那不是「跳」)。
      // 这块看板上**第一次**打标签那一下会长出那一行(同 800 那格,在库里第一枚标签建成时就长,留着)。
      if (visible.some((x) => x.topics.length > 0)) tagRowBoards.add(cur.id);
      filterRow.classList.toggle("keep-tags", tagRowBoards.has(cur.id));
      const timeNarrowed = applyTimeFilter(visible, timeFilter, (t) => t.created_at);
      if (visible.length > 0) {
        renderTimePills(timeBar, visible, (t) => t.created_at, timeFilter, (b) => {
          timeFilter = b;
          void load();
        }, "created");
        // 类型轴在标签 pills 之上(路线 A 钻取器);renderKindPills 无 kind 时清空、CSS
        // :empty 隐整行。标签 pills 随 kind 收到该类型内(见 filter-bar.ts)。
        renderKindPills(kindBar, timeNarrowed, allTopics, filter, () => void load());
        renderFilterPills(filterBar, timeNarrowed, allTopics, filter, () => void load());
        wireTagPills();
      } else {
        // 占位那一行与第一张进来之后同高:时间轴照画(全是 0、看不见),类型 / 标签两轴清空。
        renderTimePills(timeBar, visible, (t) => t.created_at, timeFilter, () => {}, "created");
        kindBar.replaceChildren();
        filterBar.replaceChildren();
      }

      // 到期汇总(502):计数按**整块看板**算(不随任何筛选收缩)—— 它回答的是「今天我
      // 该处理什么」,那句话的意思不该被当前视野改写。跳转定位那条路把筛选清空时它也一并
      // 关掉(不然「跳转即揭示」会被它筛掉)。
      if (focusOnBoard) dueOnly = false;
      const dueNow = visible.filter((t) => dueAttentionState(t, today, doneCols) === "today").length;
      const dueLate = visible.filter((t) => dueAttentionState(t, today, doneCols) === "overdue").length;
      const dueNext = visible.filter((t) => isDueSoon(t, today, doneCols)).length; // 快到期(60-A)
      paintDueSoon(dueNow, dueLate, dueNext);
      paintSortBtn(); // dueOnly 这一轮的终值已经摆定(上面 paintDueSoon 可能刚把它归零)

      const shownAll = applyFilter(timeNarrowed, filter, (t) => t.title, allTopics);
      const shown = dueOnly
        ? shownAll.filter((t) => {
            const st = dueAttentionState(t, today, doneCols);
            return st === "today" || st === "overdue" || isDueSoon(t, today, doneCols);
          })
        : shownAll;

      // Filtered(时间/标签/文本/到期任一激活): the column DOM is only the visible subset, so
      // drops route through reorder_task_visible (merged server-side). Unfiltered: the
      // strong-contract path.
      filtered = timeFilter !== "all" || filterActive(filter) || dueOnly;
      paintFilterCount(filterCount, filtered ? shown.length : null); // Q8(WD-20):筛着写「筛出 N 条」

      if (visible.length === 0) renderEmptyBoard(sealedHere);
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
      renderError(errText(err));
    }
  }

  // 排序钮:点一下换下一档(手动 → 最新在前 → 最早在前 → 手动)。非默认档高亮成朱砂,
  // 且 title 明说「拖动已停用」—— 否则用户会以为拖拽坏了(那正是 498 那条账的教训)。
  // dueOnly 同理会停拖拽(sortByDue 接管列内序),即使 boardSort 仍是「手动」也要说清楚,
  // 不然这颗按钮自己看着还是「手动」、没人告诉你为什么拖不动了。
  function paintSortBtn(): void {
    sortLbl.textContent = sortLabel(boardSort);
    sortShort.textContent = sortLabelShort(boardSort);
    sortBtn.classList.toggle("active", boardSort !== "manual");
    sortBtn.title =
      boardSort !== "manual" ? t("board.sortTitleLocked") : dueOnly ? t("board.sortTitleLockedDue") : t("board.sortTitle");
  }
  sortBtn.addEventListener("click", () => {
    boardSort = SORT_CYCLE[(SORT_CYCLE.indexOf(boardSort) + 1) % SORT_CYCLE.length];
    localStorage.setItem(SORT_KEY, boardSort);
    lastSig = ""; // 排序不改数据,指纹不会变 —— 不清它这一次重画会被短路掉
    void load();
  });
  paintSortBtn(); // 首帧就按记住的档显示,别先闪一下「手动」再被 load() 改掉(163 契约)

  /** 到期汇总钮:有逾期就说逾期(朱砂),否则只说今天;60-A 起再挂一段「N 天内 K」。
   *  ⭐ **三者皆无才整枚藏起** —— 「今天没事、但后天有」正是提前预警最该说话的那天,
   *  按 late+now 藏起等于这功能永远看不见。
   *  ⛔ **朱砂只跟着逾期走**(`.late` 的条件一个字没动):快到期不是坏消息,不该抢眼。 */
  function paintDueSoon(dueNow: number, dueLate: number, dueNext: number): void {
    if (dueNow + dueLate + dueNext === 0) {
      dueSoonBtn.hidden = true;
      dueOnly = false; // 筛着到期时把最后一条做掉了:别留下一个筛空的看板
      return;
    }
    dueSoonBtn.hidden = false;
    // 「逾期/今天」那半与每日提醒念同一个数(见 dueSummaryFullLabel:预警那段刻意不进通知)。
    dueSoonLbl.textContent = dueSummaryFullLabel(dueLate, dueNow, dueNext);
    // 窄窗字母态(board.css 那个 1099 断点)只剩这个总数 —— 三段合一,朱砂描边仍只跟逾期走;
    // 分项看 title 或点开。此前字母态下这枚只有 .lbl,隐掉就成一个空椭圆(用户面 61)。
    dueSoonN.textContent = String(dueLate + dueNow + dueNext);
    dueSoonBtn.classList.toggle("late", dueLate > 0);
    dueSoonBtn.classList.toggle("active", dueOnly);
  }
  dueSoonBtn.addEventListener("click", () => {
    dueOnly = !dueOnly;
    lastSig = ""; // 同排序钮:数据没变,不清指纹这一次重画会被短路
    void load();
  });
  armMidnightRefresh();

  // 168:人在落点页里自己换了子视图(回收站 / 归档册)= 走开了,那枚「Esc 回搜索」作废(同 notebook 换页那条)。
  function toggleTrash(): void {
    clearSearchBack();
    boardView = boardView === "trash" ? "board" : "trash";
    load();
  }
  trashToggle.addEventListener("click", toggleTrash);

  function toggleSealed(): void {
    clearSearchBack();
    const fromHolding = boardView === "holding";
    boardView = boardView === "sealed" ? "board" : "sealed";
    // B12 / 902 F8:从某块看板进归档册 ⇒ **恒选那块**(多看板的库里它恒在筛选排里;只有一块活看板、不出筛选排时
    // renderSealed 自己落回「全部看板」)。从收容区进来没有「当前看板」⇒ 选「全部看板」。
    // ⚠ 只有「进入」这一下定选择:册内重载(取消归档之后 / 远端变更)不走这里,筛选留在人选的那一枚上。
    if (boardView === "sealed") {
      sealedNoHome = fromHolding;
      sealedBoard = fromHolding ? null : (cur?.id ?? null);
    }
    load();
  }
  sealToggle.addEventListener("click", toggleSealed);

  // 视图级全局单键(不悬停卡片也生效;键义和卡片单键错开):N 新建任务、R 回收站切换、
  // G 归档切换(卡片单键 A 是「归档这张卡」,视图键须错开)。全屏时鼠标要跑到右上角很远,
  // 键盘直达。
  const teardownViewKeys = registerViewKeys([
    { key: BOARD_VIEW_KEYS.compose, run: () => { if (boardView === "board" && !blockedCompose()) setComposeOpen(true); } },
    { key: BOARD_VIEW_KEYS.trash, run: toggleTrash },
    { key: BOARD_VIEW_KEYS.sealed, run: toggleSealed },
  ]);

  const boardHeader = view.querySelector("header") as HTMLElement;
  // ⭐ W4 A20(WD-11)**页头让位改成「按这一刻真装不装得下」**:此前三档断点是 container query 写死的
  // 宽度,按**最坏内容**量的(到期三段全满、计数三位数、英文另一套)⇒ 界面字号放大一档(110%,顶栏 CSS 宽
  // 少一截)就掉进字母态,只剩「+ N」「≡」「0」「0」,而页头中间其实还空着一大截。⇒ 从全形起逐档试,
  // 取**第一档放得下一行**的(板子上真有的字、真有的计数);让的顺序照旧「先让不丢能力的」(board.css)。
  // 何时重量:顶栏变宽变窄(窗 / 侧栏折叠 / 字号档,ResizeObserver 看宽)、页头里的字或显隐变了
  // (到期数、计数、「顺序」换档、进出回收站 —— MutationObserver)、字体加载完。
  const FIT_TIERS: string[][] = [
    [],
    ["hdr-nok"],
    ["hdr-nok", "hdr-short"],
    ["hdr-short", "hdr-letter"],
  ];
  const FIT_ALL = ["hdr-nok", "hdr-short", "hdr-letter"];
  const headTools = boardHeader.querySelector(".head-tools") as HTMLElement;
  const headTitle = boardHeader.querySelector("h1") as HTMLElement;
  /** 一行放得下:那一组钮没被挤到第二行,也没横着溢出。 */
  const headerFits = (): boolean =>
    headTools.getBoundingClientRect().top < headTitle.getBoundingClientRect().bottom &&
    boardHeader.scrollWidth <= boardHeader.clientWidth;
  // D11:上一次排档时页头里长什么样(标题 + 那排钮的标记)。没变就不重排 —— 每次 load 都会重写几枚钮的类、
  // 原样写回计数,MutationObserver 照样派过来;逐档试一遍要强制重排 5 次。`force` = 量的前提变了而标记没变:
  // 内容宽变了(ResizeObserver 已按宽去重;⚠ 别拿 clientWidth 进 key —— 它含内边距,内边距一变它不动)、字体刚加载完。
  let fitKey = "";
  const fitHeader = (force = false): void => {
    const key = `${headTitle.textContent}|${headTools.innerHTML}`;
    if (!force && key === fitKey) return;
    fitKey = key;
    let tier = FIT_TIERS.length - 1;
    for (let i = 0; i < FIT_TIERS.length; i++) {
      boardHeader.classList.remove(...FIT_ALL);
      boardHeader.classList.add(...FIT_TIERS[i]);
      if (headerFits()) {
        tier = i;
        break;
      }
    }
    boardHeader.dataset.fit = String(tier); // e2e 与探针读这一格,不靠猜断点
  };
  let fitWidth = -1;
  const hdrRO = new ResizeObserver((entries) => {
    // 只看内容宽:换档会改页头高度(两行 ↔ 一行),高度变化再触发一次时不重量,免得来回跳。
    const w = entries[entries.length - 1].contentRect.width;
    if (w === fitWidth) return;
    fitWidth = w;
    fitHeader(true);
  }); // observe() 自己会先派一次,不必手动初始化
  hdrRO.observe(boardHeader);
  // 页头自己的类(换档)不算内容变化 —— 只认它**里面**那几枚钮的字与显隐。
  const hdrMO = new MutationObserver((records) => {
    if (records.some((r) => r.target !== boardHeader)) fitHeader();
  });
  hdrMO.observe(boardHeader, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });
  void document.fonts.ready.then(() => {
    if (!unmounted) fitHeader(true);
  });

  composeCtl.setLiveReload(() => void load()); // 本 mount 即当前活看板:旧保存链落账后经它通知重读(codex 四审 M)
  // 同一拍里叫了好几次「重取」(广播一声 + 紧接着切块 / 新建完再切过来)只发一趟:微任务里合并(D10)。
  let loadQueued = false;
  function queueLoad(): void {
    if (loadQueued) return;
    loadQueued = true;
    queueMicrotask(() => {
      loadQueued = false;
      void load();
    });
  }
  // 0043:侧栏那边动了看板(建 / 改名 / 排序 / 删、把卡拖到某块看板名上)、本视图自己挪了卡 / 改了列 ⇒ 重取。
  // 侧栏在本视图挂着时不自己取,等这一发经 BOARD_DATA 交过去(D10)。
  const onBoardsChanged = (): void => queueLoad();
  document.addEventListener(BOARDS_CHANGED, onBoardsChanged);
  setBoardViewLive(true);
  void load();

  return {
    // D9:看板视图已挂着时点侧栏里的一块看板(或「看板」本身、收容区那一行)= 就地换,不整页卸载重挂 —— 新建框里
    // 打了一半的字、开着的编辑都还在(编辑由 load 先落盘再画)。在看哪块已由侧栏记进 localStorage,load 读它;
    // 换了块的筛选清法在 load 里(R5)。子视图与「只看到期」这类 mount 级 peek 同重挂时一样回到看板。
    reselect() {
      clearSearchBack(); // 人换了地方:那枚「Esc 回搜索」作废(同 notebook 换页)
      boardView = pendingView ?? "board";
      pendingView = null;
      sealedBoard = null;
      sealedNoHome = false;
      dueOnly = false;
      queueLoad();
      return true;
    },
    unmount() {
      // 作废本 mount 的在途 load(codex 四审 H):loadSeq 是 mount 局部,但 focusId 是模块
      // 全局——不 bump 的话,旧 mount 晚回的 load 仍满足自己的 seq 守卫,会消费掉后来新
      // mount 的 focusId、在已脱离 DOM 的旧看板上渲染,新看板反而拿不到跳转。顺带清 focusId,
      // 明确取消"离开看板时尚未落地的这次定位"。
      unmounted = true;
      offFilterFold();
      document.removeEventListener(BOARDS_CHANGED, onBoardsChanged);
      setBoardViewLive(false);
      markActiveBoard(null); // 侧栏上「正在看哪块」的标随视图走
      setDraggingCard(null);
      typeAhead?.release(); // 待开编辑那一秒内切走:收键的监听不跨 mount
      memo.time = timeFilter; // Q6:这个空间的时间轴选择写回(filter 是同一对象,已经在里面)
      dragging = null;
      stopAutoScroll(); // 拖到一半切视图:rAF 循环不许活过这棵 mount
      clearTimeout(midnightTimer); // 跨午夜重算的定时器同理不跨 mount(502)
      composeCtl.setLiveReload(null); // navigate 恒先 unmount 再 mount:新 mount 会立即接管
      loadSeq++;
      focusId = null;
      dismissUndo(); // 撤销钮指着这棵 mount 的条目:切视图 / 切空间就收(716)
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
      closeMoreMenu(); // 页头「⋯」菜单 portal 在 body 上,不随视图根节点走
      closeColumnManager(); // 同上:列管理面也 portal 在 body 上,且它的 onChanged 指着这一棵 mount 的 load()
      closeHistoryDialog(); // 同上(158 G4-A8):历史读框取数走「当前空间」,切了空间还开着就会拿旧 id 去问新空间
      teardownViewKeys();
      hdrRO.disconnect(); // 65:观察的是本 mount 的 header,不许活过这棵 mount
      hdrMO.disconnect(); // W4 A20:同上
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
