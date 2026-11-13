// 列管理面(B-f 第 2 段;board-columns-plan §8 那张表末行)。
//
// ⭐ 0043(multiboard-plan §6)起管的是**一块看板**:它的列 + 两个角色(新卡落点 / 完成列)+ 这块看板
// 本身(改名 / 删)。角色是看板上的指针(core 解析,`Board.landing` / `Board.done`),⛔ 前端不另算;
// 改角色走 `board/set_field`,**不过**列的那道发送端闸(plan §5.1)⇒ 闸关着时那一节照样可写。
//
// 看板顶栏「管理看板」(侧栏右键一块看板名「管理看板」同)→ 这一面:列的**新建 / 改名 / 拖顺序 / 删**。
// ⭐ **纯桌面**:安卓只做读侧(2026-08-25 用户拍板①,plan §8.6 四)——那不是债,是产品范围。
// ⭐ 开在**看板顶栏**、不占左侧栏、不进「设置」面(同日拍板③:那一面今天全是纯本地不同步
// 的项,而列是同步实体)。
//
// # ⛔ 这一面不拥有任何判定(plan §8.1-2)
//
// 「能不能写」= `loadColumnGate()`(core 的发送端闸,§5);「这一列能不能删」=
// `deletable` × `live_items`(core 的 `undeletable_reason` × `live_item_count`);
// 「画哪几列」= `boardColumns()`(与看板**同一枚**谓词)。⛔ 一句都别在这儿重写。
// 每道拒绝的人话也一律是 core 出的原文 —— 前端只在闩那一格**另接**一句补充说明(拍板②)。
//
// # 遮罩与形照 settings 面板那一路
//
// 浅雾玻璃 = 「操作型面板」(348 分野判据);Esc 关、点遮罩关、面板挂 `document.body`
// (portal —— 留在看板里会被 `.cols` 那层 `overflow:auto` 裁掉,同 hotkey-menu 那个坑)。
import {
  type BoardColumn,
  type ColumnGate,
  boardColumns,
  columnName,
  createColumn,
  deleteColumn,
  loadBoardColumns,
  loadColumnGate,
  renameColumn,
  reorderColumn,
} from "./board-columns";
import {
  type Board,
  boardName,
  deleteBoard,
  loadBoards,
  renameBoard,
  setBoardDone,
  setBoardLanding,
} from "./boards";
import { openNewBoard } from "./board-new";
import { t } from "./i18n";
import "./column-manager.css";
import { el, focusables, onDragTarget, trapTab } from "./dom";
import { errDetail, errText } from "./err";

let overlay: HTMLDivElement | null = null;

/** 列变了要回看板重画(board.ts 传进来的 `load`)。面板关掉即摘。 */
let onChanged: (() => void) | null = null;
/** 管的是哪块看板(0043)。面板关掉即摘。 */
let boardId: string | null = null;
/** 打开这一面时焦点所在的那一枚(看板页头「⋯」/ 侧栏那一行):关掉时还给它(900 C8;ui-guidelines §3.5
 *  「关完焦点还给打开它的那枚」—— 此前关掉后焦点掉到 body,键盘用户得从头 Tab 回来)。 */
let opener: HTMLElement | null = null;

/**
 * 打开列管理面。`opts.onChanged` 在**每一笔写成功之后**调用(看板在背后跟着重画),
 * ⛔ 不是只在关闭时调一次:面板开着的时候看板就该已经是新的了。
 */
export function openColumnManager(opts: { boardId: string; onChanged: () => void; opener?: HTMLElement | null }): void {
  if (overlay) return;
  onChanged = opts.onChanged;
  boardId = opts.boardId;
  // `opts.opener`:从「新建看板」取消回来重开的那一次,焦点此刻在 body 上 —— 由调用方把最初那一枚带回来。
  const a = document.activeElement;
  opener = opts.opener !== undefined ? opts.opener : a instanceof HTMLElement && a !== document.body ? a : null;
  overlay = el("div", { className: "bcm-overlay" });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeColumnManager();
  });
  // 158 G2 / A12(WD-14 / N-9):模态面板三件套(ui-guidelines §3.5)—— role=dialog、打开即聚焦首个控件、
  // Tab 圈在面板里(此前焦点留在背后的「管理列」钮,连按 Tab 跑到看板卡上的标签 ✕)。
  const panel = el("div", { className: "bcm-panel" });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", t("cols.title"));
  overlay.append(panel);
  document.body.append(overlay);
  document.addEventListener("keydown", onPanelEsc);
  void render(panel, "first");
}

/**
 * 关掉面板。**看板 unmount 时必须调**(切空间 / 切视图)——否则这一面会挂在一棵已经
 * 不存在的看板上,而它的 `onChanged` 指向死 mount 的 `load()`
 * (memory `module-state-hoisting-checklist` 那五坑)。
 */
export function closeColumnManager(): void {
  const was = overlay;
  const back = opener;
  opener = null;
  overlay?.remove();
  overlay = null;
  // 焦点还给打开它的那一枚(还在文档里才还;看板 unmount 那条路上它多半已经不在了)。面板本来就没开着 = 不动焦点。
  if (was && back?.isConnected) back.focus({ preventScroll: true });
  onChanged = null;
  boardId = null;
  // ⛔ 别漏这一句:`draggingId` 是模块态,留着旧值的话下一次开面板时,任何一次
  // **不是从这儿发起**的拖动(拖个文件进窗口就够)扫过某一行都会被当成「在拖那一列」
  // ⇒ 一次没人要求的排序写。dragend 正常会清它,这里守的是「拖到一半面板没了」。
  draggingId = null;
  document.removeEventListener("keydown", onPanelEsc);
}

function onPanelEsc(e: KeyboardEvent): void {
  // Tab 圈闭挂在 document 上而不是面板上:焦点掉到 body(行内改名 Esc 收掉之后)时也接得住。
  const panel = overlay?.querySelector<HTMLElement>(".bcm-panel");
  if (panel) trapTab(panel, e);
  if (e.key !== "Escape") return;
  // 行内改名在场时这一句到不了:它的 keydown 挂在 input 上(冒泡的起点),那儿先
  // `stopPropagation()` 收掉自己那一层,document 上的这只根本收不到。
  e.stopPropagation();
  closeColumnManager();
}

// ---- 渲染 ------------------------------------------------------------------------------

/** 删列确认出现后多久才接执行钮(§3.2 第 2 条「300ms 防连击」那一支)。 */
const CONFIRM_ARM_MS = 300;

/** 拖动中的那一列 id(与 topics 的 `draggingTopicId` 同形)。 */
let draggingId: string | null = null;

/**
 * 重画代次。⚠ **不是洁癖**:每一笔写落地都重画一次,而两个操作是可以叠着来的
 * (删完一列紧接着在新建框里回车)⇒ 早发的那趟 `await` 回来得晚,就会拿**旧**的列表
 * 把新的盖掉(仓里既有的形:`board.ts` 的 `loadSeq` / `space.ts` 的迟到响应丢弃)。
 */
let renderSeq = 0;

/** 重画后焦点落哪儿:`first` = 首个控件(刚打开);`new` = 新建框(连着建几列,此前回车建完焦点掉到 body,
 *  接着打的字哪儿都没进,WD-14);`keep` = 焦点还在面板里就不动、掉出去了才收回首个控件。 */
type Refocus = "first" | "new" | "keep";

async function render(panel: HTMLElement, refocus: Refocus = "keep"): Promise<void> {
  const seq = ++renderSeq;
  let cols: BoardColumn[];
  let gate: ColumnGate;
  let boards: Board[];
  try {
    // 三发并发:列、闸、看板没有先后依赖。⚠ 闸答的是「问的那一刻」,故每次重画都重问一遍
    // (§5.2:⛔ 不许 mount 时算好一个 bool 长期缓存)。
    [cols, gate, boards] = await Promise.all([loadBoardColumns(), loadColumnGate(), loadBoards()]);
  } catch (e) {
    // 读失败(含「四键残缺」那档 core 的响亮报错)照实说,⛔ 不猜一个「能用」。
    if (!overlay || seq !== renderSeq) return; // 同下:关掉了 / 有更晚一趟 ⇒ 不落 DOM
    panel.replaceChildren(
      el("h2", { className: "bcm-title", textContent: t("cols.title") }),
      el("div", { className: "bcm-err", textContent: t("cols.loadFailed", { msg: errDetail(e) }) }),
    );
    return;
  }
  if (!overlay) return; // await 期间面板已被关掉(切空间 / Esc)
  if (seq !== renderSeq) return; // 有更晚的一趟在途:旧响应⛔ 不落 DOM
  const brd = boards.find((b) => b.id === boardId && !b.deleted);
  if (!brd) {
    // 开着面板时这块看板被(别的设备)删了:照实说一句、只留关闭,⛔ 不猜别的看板。
    panel.replaceChildren(
      el("h2", { className: "bcm-title", textContent: t("cols.title") }),
      el("div", { className: "bcm-err", textContent: t("cols.boardGone") }),
    );
    return;
  }
  const board: Board = brd;
  const rows = boardColumns(cols, board.id);

  const closeBtn = el("button", {
    className: "bcm-close",
    type: "button",
    textContent: "✕",
    title: t("cols.close"),
  });
  closeBtn.setAttribute("aria-label", t("cols.close"));
  closeBtn.addEventListener("click", () => closeColumnManager());
  const head = el("div", { className: "bcm-head" }, [
    el("h2", { className: "bcm-title", textContent: t("cols.titleFor", { board: boardName(board) }) }),
    closeBtn,
  ]);
  const hint = el("p", { className: "bcm-hint", textContent: t("cols.hint") });
  const list = el("div", { className: "bcm-list" });
  const err = el("div", { className: "bcm-err", hidden: true });
  const body: (Node | string)[] = [head, hint];

  // 闸关着:一条横幅说清为什么,写入口全部收起。⭐ 那句补充说明只挂在**闩**那一格
  // (`blocked_by === "peers"`),⛔ 别按文案 match(482 自曝 ②)。
  if (!gate.can_manage) {
    const why = el("div", { className: "bcm-shut" }, [
      el("span", { className: "bcm-why", textContent: gate.reason ?? t("cols.shutUnknown") }),
    ]);
    if (gate.blocked_by === "peers") {
      why.append(el("span", { className: "bcm-tip", textContent: t("cols.peersTip") }));
    }
    body.push(why);
  }
  body.push(list);
  body.push(err);

  function showErr(msg: string): void {
    clearErr();
    err.textContent = msg;
    err.hidden = false;
  }
  function clearErr(): void {
    err.hidden = true;
    err.textContent = "";
    for (const n of panel.querySelectorAll(".bcm-row-err")) n.remove();
  }
  /** 「这块看板」那几行(新卡落在 / 完成列 / 看板名)触发的错:红字挨着那一行正下方(902 E3)。此前落在列清单下面那格
   *  共用的 `.bcm-err`,与点的那一行隔着「新增一列」和半个面板。一次只留一句(换一行再错,旧的那句收掉)。 */
  function showRowErr(rowEl: HTMLElement, msg: string): void {
    clearErr();
    rowEl.after(el("div", { className: "bcm-err bcm-row-err", textContent: msg }));
  }

  /** 一笔写落地之后:清错、看板重画、本面板按新真相重建。 */
  async function afterWrite(refocusAfter: Refocus = "keep"): Promise<void> {
    clearErr();
    onChanged?.();
    if (overlay) await render(panel, refocusAfter);
  }

  for (const c of rows) list.append(row(c));
  if (gate.can_manage) body.push(creator());
  body.push(boardSection());

  panel.replaceChildren(...body);
  const newInput = panel.querySelector<HTMLInputElement>(".bcm-new .bcm-col-input");
  if (refocus === "new" && newInput) newInput.focus();
  else if (refocus === "first" || !panel.contains(document.activeElement)) focusables(panel)[0]?.focus();

  // ---- 一行 ----------------------------------------------------------------------------
  function row(c: BoardColumn): HTMLElement {
    const sec = el("div", { className: "bcm-col" });
    sec.dataset.col = c.id; // ⛔ 机器一律读这一份:ULID 可能以数字开头,`.bcm-col.01J…` 是非法选择器
    const name = el("span", { className: "bcm-col-name", textContent: columnName(c) });
    const count = el("span", {
      className: "bcm-col-count",
      textContent: t("cols.count", { n: c.live_items }),
    });
    const acts = el("span", { className: "bcm-col-acts" });
    // 0043:两个角色在列名后面各挂一枚标(读 core 解析的指针);改它们在底下「这块看板」那一节。
    const roles: HTMLElement[] = [];
    if (c.id === board.landing) roles.push(el("span", { className: "bcm-role", textContent: t("cols.roleLanding") }));
    if (c.id === board.done) roles.push(el("span", { className: "bcm-role done", textContent: t("cols.roleDone") }));
    const headRow = el("div", { className: "bcm-col-head" }, [name, ...roles, count, acts]);
    sec.append(headRow);

    // ⚠ 这里只有活列(`boardColumns` 已滤掉删了的):删掉的列里还扣着的卡 0043 起统一进收容区(plan §3a),
    // 不再作为只读列留在这一面上。
    if (!gate.can_manage) return sec;

    // 拖动手柄:draggable 只挂它(避开行里的按钮),形与 topics 189 那套逐条同构。
    const handle = el("span", { className: "bcm-col-drag", textContent: "⠿", title: t("cols.dragHint") });
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
      draggingId = c.id;
      sec.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    handle.addEventListener("dragend", () => {
      draggingId = null;
      sec.classList.remove("dragging");
      clearDropHints();
    });
    headRow.insertBefore(handle, name);

    // dragenter 也走这一份(onDragTarget 头注:只接 dragover 的落点会在跨进子元素那一拍答「不可放」)。
    onDragTarget(sec, (e) => {
      if (draggingId === null || draggingId === c.id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = sec.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearDropHints();
      sec.classList.add(after ? "drop-after" : "drop-before");
    });
    sec.addEventListener("dragleave", () => sec.classList.remove("drop-before", "drop-after"));
    sec.addEventListener("drop", (e) => {
      if (draggingId === null || draggingId === c.id) return;
      e.preventDefault();
      const after = sec.classList.contains("drop-after");
      const dragId = draggingId;
      clearDropHints();
      void dropReorder(dragId, c.id, after);
    });

    acts.append(cbtn(t("cols.rename"), () => openRename(sec, c)));
    // ⛔ **`deletable === false` 的列不给删除钮**:种子看板的 `todo` / `done`(永不可删,plan §2.3a)、
    // 当前完成列(先取消)、看板上最后一枚能放卡的列 —— 后两种的原因由角色标 / 底下那节说清;
    // 给一枚永远灰着的钮只会让人反复去点它问为什么(`deletable` 0043 起随角色变,不是永久属性)。
    // 「非空」那一格不同:它是**用户此刻就能解掉**的条件 ⇒ 钮留着、灰着、说清还剩几条。
    if (c.deletable) {
      // 158 G2 / A12(WD-22):有卡的列删不了,原因此前只在悬停提示里(点了没反应、悬停还变红)。
      // 现在钮照样淡着(aria-disabled,⛔ 不用 disabled —— 那样点了连原因都说不出),点一下在这一行
      // 下面写明还剩几条、得先移走。
      const blocked = c.live_items > 0;
      const del = cbtn(t("cols.delete"), () => {
        if (!blocked) {
          confirmDelete(acts, c);
          return;
        }
        if (sec.querySelector(".bcm-col-note")) return;
        sec.append(el("div", { className: "bcm-col-note", textContent: t("cols.deleteBlocked", { n: c.live_items }) }));
      }, !blocked);
      if (blocked) {
        del.setAttribute("aria-disabled", "true");
        del.classList.add("blocked");
        del.title = t("cols.deleteBlocked", { n: c.live_items });
      }
      acts.append(del);
    }
    return sec;
  }

  // ---- 改名 ----------------------------------------------------------------------------
  function openRename(sec: HTMLElement, c: BoardColumn): void {
    if (sec.querySelector(".bcm-col-edit")) return;
    const shown = columnName(c);
    const input = el("input", { className: "bcm-col-input", type: "text", value: shown });
    const save = cbtn(t("cols.save"), () => void commit());
    const cancel = cbtn(t("cols.cancel"), () => form.remove());
    const form = el("div", { className: "bcm-col-edit" }, [input, save, cancel]);
    sec.append(form);
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.stopPropagation(); // ⛔ 别让这枚 Esc 冒到面板层去把整面关掉
        form.remove();
      }
    });

    async function commit(): Promise<void> {
      const next = input.value.trim();
      if (next === "") {
        showErr(t("cols.emptyName"));
        return;
      }
      // ⭐ **no-op 闸,而且它挡的是一个真陷阱**:`columnName()` 在英文档下把还没改过名的
      // `todo` 显示成 "To do";用户开了改名框原样保存,写进去的就是 "To do" ⇒ 从此
      // `is_title_overridden` 为真,**中文档下也变成 "To do"**。比对**显示名**(不是
      // `c.title`)才拦得住这条。⚠ 顺带与 topics `dropReorder` 那条「落回原位不发命令」同规:
      // 白写一枚 title、白发一条同步 op,LWW 无害但脏。
      if (next === shown) {
        form.remove();
        return;
      }
      try {
        await renameColumn(c.id, next);
      } catch (e) {
        showErr(errText(e));
        return;
      }
      await afterWrite();
    }
  }

  // ---- 删除(行内两段式:结构性动作,且删了没有撤销入口) ---------------------------------
  function confirmDelete(host: HTMLElement, c: BoardColumn): void {
    const prev = [...host.childNodes];
    // 158 G2 / A18(WD-23):顺序与高亮跟看板卡的删除确认一致 —— 「取消」在前、红实心「删除」在后。
    // W5 Q3 ★①(WD-39):焦点落在「取消」上(回车不删;要删 Tab 一下到红钮)—— 全应用的确认一个规矩,
    // 此前这里停在「删除」上、回车即删。Esc 关面板照旧。
    // ⚠ 这样排执行钮正落在触发钮(原「删除」)的位置上 ⇒ 走 ui-guidelines §3.2 第 2 条的另一支:
    // 出现后 300ms 内不接(防双击连删),不置 disabled —— 置了会先闪一下灰、焦点也落不上去。
    const armedAt = performance.now();
    const yes = cbtn(t("cols.deleteYes"), () => {
      if (performance.now() - armedAt < CONFIRM_ARM_MS) return;
      void go();
    }, true);
    yes.classList.add("solid");
    const no = cbtn(t("cols.cancel"), () => {
      host.replaceChildren(...prev);
      (prev.find((n) => n instanceof HTMLButtonElement && n.classList.contains("danger")) as HTMLElement | undefined)?.focus();
    });
    host.replaceChildren(el("span", { className: "bcm-col-q", textContent: t("cols.deleteQ") }), no, yes);
    no.focus();

    async function go(): Promise<void> {
      try {
        await deleteColumn(c.id);
      } catch (e) {
        host.replaceChildren(...prev);
        showErr(errText(e));
        return;
      }
      await afterWrite();
    }
  }

  // ---- 新建 ----------------------------------------------------------------------------
  function creator(): HTMLElement {
    const input = el("input", {
      className: "bcm-col-input",
      type: "text",
      placeholder: t("cols.newPlaceholder"),
    });
    const add = cbtn(t("cols.add"), () => void go());
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      void go();
    });
    async function go(): Promise<void> {
      const title = input.value.trim();
      if (title === "") {
        showErr(t("cols.emptyName"));
        return;
      }
      try {
        await createColumn(title, board.id);
      } catch (e) {
        showErr(errText(e));
        return;
      }
      input.value = "";
      await afterWrite("new");
    }
    return el("div", { className: "bcm-new" }, [input, add]);
  }

  // ---- 这块看板(0043):两个角色 + 改名 + 删 -------------------------------------------
  // 角色用一排药丸选(当前那枚按下):列是个位数,一眼看全,比下拉直。⛔ 候选与限制只防「点了必然被拒」,
  // 真正的前置(新旧完成列都得空着、落点≠完成列…)在 core,拒了原样显那句话。
  function boardSection(): HTMLElement {
    const sec = el("div", { className: "bcm-board" }, [
      el("h3", { className: "bcm-sub", textContent: t("cols.boardSection") }),
    ]);
    // 新卡落在:除完成列以外的活列。
    // 三行各自先建出来:里面的钮被拒时红字要落在自己那一行下面(showRowErr),回调里得拿得到那一行。
    const landingRow = roleRow(t("cols.landingLabel"), []);
    const doneRow = roleRow(t("cols.doneLabel"), []);
    const nameRow = roleRow(t("cols.boardName"), []);
    const fill = (rowEl: HTMLElement, items: HTMLElement[]): void => {
      (rowEl.querySelector(".bcm-role-pills") as HTMLElement).append(...items);
    };
    const landingPills = rows
      .filter((c) => c.id !== board.done)
      .map((c) =>
        pill(columnName(c), c.id === board.landing, () => void write(() => setBoardLanding(board.id, c.id), landingRow)),
      );
    fill(landingRow, landingPills);
    sec.append(landingRow);
    // 完成列:「不设」+ 除落点以外的活列;只有一列的看板不能设(core 同拒,这里不摆)。
    const donePills = [
      pill(t("cols.doneNone"), board.done === null, () => void write(() => setBoardDone(board.id, null), doneRow)),
      ...(rows.length < 2
        ? []
        : rows
            .filter((c) => c.id !== board.landing)
            .map((c) => pill(columnName(c), c.id === board.done, () => void write(() => setBoardDone(board.id, c.id), doneRow)))),
    ];
    fill(doneRow, donePills);
    sec.append(doneRow);
    sec.append(el("p", { className: "bcm-hint", textContent: board.done === null ? t("cols.doneNoneHint") : t("cols.doneHint") }));

    // 改看板名(no-op 闸同列改名:比显示名,别把本端字典的种子名写进库)。
    const nameInput = el("input", { className: "bcm-col-input", type: "text", value: boardName(board) });
    const saveName = cbtn(t("cols.save"), () => void commitName());
    nameInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      void commitName();
    });
    async function commitName(): Promise<void> {
      const next = nameInput.value.trim();
      if (next === "") {
        showRowErr(nameRow, t("cols.emptyBoardName"));
        return;
      }
      if (next === boardName(board)) return;
      await write(() => renameBoard(board.id, next), nameRow);
    }
    fill(nameRow, [nameInput, saveName]);
    sec.append(nameRow);

    // 删这块看板:种子看板不给;有卡(含已删列里的)= 淡着、点了说还剩几张(同删列)。
    if (board.deletable) {
      const n = cols.filter((c) => c.kind === "task" && c.board_id === board.id).reduce((s, c) => s + c.live_items, 0);
      const acts = el("div", { className: "bcm-board-del" });
      const del = cbtn(t("cols.deleteBoard"), () => {
        if (n > 0) {
          if (!sec.querySelector(".bcm-col-note"))
            sec.append(el("div", { className: "bcm-col-note", textContent: t("cols.deleteBoardBlocked", { n }) }));
          return;
        }
        const prev = [...acts.childNodes];
        const armedAt = performance.now();
        const yes = cbtn(t("cols.deleteYes"), () => {
          if (performance.now() - armedAt < CONFIRM_ARM_MS) return;
          void (async () => {
            try {
              await deleteBoard(board.id);
            } catch (e) {
              acts.replaceChildren(...prev);
              showErr(errText(e));
              return;
            }
            onChanged?.();
            closeColumnManager(); // 看板没了,这一面也没东西可管了(看板视图回到默认看板)
          })();
        }, true);
        yes.classList.add("solid");
        const no = cbtn(t("cols.cancel"), () => acts.replaceChildren(...prev));
        acts.replaceChildren(el("span", { className: "bcm-col-q", textContent: t("cols.deleteBoardQ") }), no, yes);
        no.focus();
      }, n === 0);
      if (n > 0) {
        del.setAttribute("aria-disabled", "true");
        del.classList.add("blocked");
        del.title = t("cols.deleteBoardBlocked", { n });
      }
      acts.append(del);
      sec.append(acts);
    }
    // 新建另一块看板(只有一块看板时侧栏不展开,这里是它的入口;渐进式披露,用户 2026-11-11 拍)。
    // 先关这一面再开对话框:两层遮罩叠着,Esc / 点遮罩会分不清关的是谁。没建就关掉 ⇒ 原样回到这一面
    // (此前取消了两层都没了,人得再点一次「管理看板」)。
    const another = cbtn(t("cols.newBoard"), () => {
      const cb = onChanged;
      if (cb === null) throw new Error("column manager is open without onChanged"); // openColumnManager 恒给,缺了是 bug
      const id = board.id;
      const back = opener; // 最初打开这一面的那一枚:closeColumnManager 把焦点还给它,「新建看板」于是记它为自己的 opener
      closeColumnManager();
      openNewBoard(undefined, () => openColumnManager({ boardId: id, onChanged: cb, opener: back }));
    });
    sec.append(el("div", { className: "bcm-board-del" }, [another]));
    return sec;
  }
  function roleRow(label: string, items: HTMLElement[]): HTMLElement {
    return el("div", { className: "bcm-role-row" }, [
      el("span", { className: "bcm-role-label", textContent: label }),
      el("div", { className: "bcm-role-pills" }, items),
    ]);
  }
  function pill(label: string, on: boolean, run: () => void): HTMLElement {
    const b = el("button", { className: on ? "bcm-pill on" : "bcm-pill", type: "button", textContent: label });
    b.setAttribute("aria-pressed", String(on));
    // 900 C4:列名是用户起的、可以任意长 ⇒ 这枚封顶到行宽、省略(column-manager.css `.bcm-pill`);被省略时完整名字进 title。
    b.addEventListener("mouseenter", () => {
      b.title = b.scrollWidth > b.clientWidth ? label : "";
    });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!on) run();
    });
    return b;
  }
  async function write(op: () => Promise<void>, rowEl: HTMLElement): Promise<void> {
    try {
      await op();
    } catch (e) {
      showRowErr(rowEl, errText(e));
      return;
    }
    await afterWrite();
  }

  // ---- 拖排序(整套复用 topics 189 那条:同层兄弟、按落点算前后邻居、只写被拖那一枚) ----
  function clearDropHints(): void {
    for (const s of list.querySelectorAll(".bcm-col")) s.classList.remove("drop-before", "drop-after");
  }

  /**
   * 把 `dragId` 落到 `targetId` 的前 / 后。邻居按 DOM 顺序取(= `position` 顺序)。
   *
   * ⚠ 邻居只在**这一面列出的那几列**里取 ⇒ 拖到最左时 `prevId = null`,算出的键可能落在
   * 灵感那两列(`a0`/`a1`)之前。**无害**:`position` 是全局排序轴,而两端的灵感视图根本
   * 不看它,看板只按任务列的**相对**序画。
   */
  async function dropReorder(dragId: string, targetId: string, after: boolean): Promise<void> {
    const ids = [...list.querySelectorAll<HTMLElement>(".bcm-col")].map((s) => s.dataset.col as string);
    const sibs = ids.filter((id) => id !== dragId);
    const tIdx = sibs.indexOf(targetId);
    if (tIdx < 0) return;
    const prevId = after ? targetId : (sibs[tIdx - 1] ?? null);
    const nextId = after ? (sibs[tIdx + 1] ?? null) : targetId;
    // 落回原位(前后邻都没变)= no-op,不发命令。当前邻居按**含**被拖行的 DOM 顺序取。
    const dIdx = ids.indexOf(dragId);
    if ((ids[dIdx - 1] ?? null) === prevId && (ids[dIdx + 1] ?? null) === nextId) return;
    try {
      await reorderColumn(dragId, prevId, nextId);
    } catch (e) {
      showErr(errText(e));
      return;
    }
    await afterWrite();
  }
}

/** 面板里的小按钮(热区由 CSS 的 min-height 自保,见 column-manager.css)。 */
function cbtn(label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const b = el("button", {
    className: danger ? "bcm-btn danger" : "bcm-btn",
    type: "button",
    textContent: label,
  });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
