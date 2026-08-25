// 列管理面(B-f 第 2 段;board-columns-plan §8 那张表末行)。
//
// 看板顶栏「管理列」→ 这一面:**新建 / 改名 / 拖顺序 / 删**。
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
import { t } from "./i18n";
import "./column-manager.css";

let overlay: HTMLDivElement | null = null;

/** 列变了要回看板重画(board.ts 传进来的 `load`)。面板关掉即摘。 */
let onChanged: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

/**
 * 打开列管理面。`opts.onChanged` 在**每一笔写成功之后**调用(看板在背后跟着重画),
 * ⛔ 不是只在关闭时调一次:面板开着的时候看板就该已经是新的了。
 */
export function openColumnManager(opts: { onChanged: () => void }): void {
  if (overlay) return;
  onChanged = opts.onChanged;
  overlay = el("div", { className: "bcm-overlay" });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeColumnManager();
  });
  const panel = el("div", { className: "bcm-panel" });
  overlay.append(panel);
  document.body.append(overlay);
  document.addEventListener("keydown", onPanelEsc);
  void render(panel);
}

/**
 * 关掉面板。**看板 unmount 时必须调**(切空间 / 切视图)——否则这一面会挂在一棵已经
 * 不存在的看板上,而它的 `onChanged` 指向死 mount 的 `load()`
 * (memory `module-state-hoisting-checklist` 那五坑)。
 */
export function closeColumnManager(): void {
  overlay?.remove();
  overlay = null;
  onChanged = null;
  // ⛔ 别漏这一句:`draggingId` 是模块态,留着旧值的话下一次开面板时,任何一次
  // **不是从这儿发起**的拖动(拖个文件进窗口就够)扫过某一行都会被当成「在拖那一列」
  // ⇒ 一次没人要求的排序写。dragend 正常会清它,这里守的是「拖到一半面板没了」。
  draggingId = null;
  document.removeEventListener("keydown", onPanelEsc);
}

function onPanelEsc(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  // 行内改名在场时这一句到不了:它的 keydown 挂在 input 上(冒泡的起点),那儿先
  // `stopPropagation()` 收掉自己那一层,document 上的这只根本收不到。
  e.stopPropagation();
  closeColumnManager();
}

// ---- 渲染 ------------------------------------------------------------------------------

/** 拖动中的那一列 id(与 topics 的 `draggingTopicId` 同形)。 */
let draggingId: string | null = null;

/**
 * 重画代次。⚠ **不是洁癖**:每一笔写落地都重画一次,而两个操作是可以叠着来的
 * (删完一列紧接着在新建框里回车)⇒ 早发的那趟 `await` 回来得晚,就会拿**旧**的列表
 * 把新的盖掉(仓里既有的形:`board.ts` 的 `loadSeq` / `space.ts` 的迟到响应丢弃)。
 */
let renderSeq = 0;

async function render(panel: HTMLElement): Promise<void> {
  const seq = ++renderSeq;
  let cols: BoardColumn[];
  let gate: ColumnGate;
  try {
    // 两发并发:列与闸没有先后依赖。⚠ 闸答的是「问的那一刻」,故每次重画都重问一遍
    // (§5.2:⛔ 不许 mount 时算好一个 bool 长期缓存)。
    [cols, gate] = await Promise.all([loadBoardColumns(), loadColumnGate()]);
  } catch (e) {
    // 读失败(含「四键残缺」那档 core 的响亮报错)照实说,⛔ 不猜一个「能用」。
    if (!overlay || seq !== renderSeq) return; // 同下:关掉了 / 有更晚一趟 ⇒ 不落 DOM
    panel.replaceChildren(
      el("h2", { className: "bcm-title", textContent: t("cols.title") }),
      el("div", { className: "bcm-err", textContent: t("cols.loadFailed", { msg: String(e) }) }),
    );
    return;
  }
  if (!overlay) return; // await 期间面板已被关掉(切空间 / Esc)
  if (seq !== renderSeq) return; // 有更晚的一趟在途:旧响应⛔ 不落 DOM
  const rows = boardColumns(cols);

  const head = el("h2", { className: "bcm-title", textContent: t("cols.title") });
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
    err.textContent = msg;
    err.hidden = false;
  }
  function clearErr(): void {
    err.hidden = true;
    err.textContent = "";
  }

  /** 一笔写落地之后:清错、看板重画、本面板按新真相重建。 */
  async function afterWrite(): Promise<void> {
    clearErr();
    onChanged?.();
    if (overlay) await render(panel);
  }

  for (const c of rows) list.append(row(c));
  if (gate.can_manage) body.push(creator());

  panel.replaceChildren(...body);

  // ---- 一行 ----------------------------------------------------------------------------
  function row(c: BoardColumn): HTMLElement {
    const sec = el("div", { className: c.deleted ? "bcm-col gone" : "bcm-col" });
    sec.dataset.col = c.id; // ⛔ 机器一律读这一份:ULID 可能以数字开头,`.bcm-col.01J…` 是非法选择器
    const name = el("span", { className: "bcm-col-name", textContent: columnName(c) });
    const count = el("span", {
      className: "bcm-col-count",
      textContent: t("cols.count", { n: c.live_items }),
    });
    const acts = el("span", { className: "bcm-col-acts" });
    const headRow = el("div", { className: "bcm-col-head" }, [name, count, acts]);
    sec.append(headRow);

    // 已删的列 = 只读收容区(§4.3):列身还画着是因为**还有卡扣在里面**,卡只出不进,
    // 改名 / 排序 / 再删一次全被 core 拒 ⇒ 这里一个动作按钮都不给,只挂一枚标。
    if (c.deleted) {
      headRow.insertBefore(el("span", { className: "bcm-col-gone", textContent: t("cols.deleted") }), count);
      return sec;
    }
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

    sec.addEventListener("dragover", (e) => {
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
    // ⛔ **`deletable === false` 的那两列根本不给按钮** —— 那是列的**永久属性**(挂着产品
    // 语义的落点与完成列,plan §2.3a),给一枚永远灰着的钮只会让人反复去点它问为什么。
    // 「非空」那一格不同:它是**用户此刻就能解掉**的条件 ⇒ 钮留着、灰着、说清还剩几条。
    if (c.deletable) {
      const del = cbtn(t("cols.delete"), () => confirmDelete(acts, c), true);
      if (c.live_items > 0) {
        del.disabled = true;
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
        showErr(String(e));
        return;
      }
      await afterWrite();
    }
  }

  // ---- 删除(行内两段式:结构性动作,且删了没有撤销入口) ---------------------------------
  function confirmDelete(host: HTMLElement, c: BoardColumn): void {
    const prev = [...host.childNodes];
    const yes = cbtn(t("cols.deleteYes"), () => void go(), true);
    const no = cbtn(t("cols.cancel"), () => host.replaceChildren(...prev));
    host.replaceChildren(el("span", { className: "bcm-col-q", textContent: t("cols.deleteQ") }), yes, no);

    async function go(): Promise<void> {
      try {
        await deleteColumn(c.id);
      } catch (e) {
        host.replaceChildren(...prev);
        showErr(String(e));
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
        await createColumn(title);
      } catch (e) {
        showErr(String(e));
        return;
      }
      input.value = "";
      await afterWrite();
    }
    return el("div", { className: "bcm-new" }, [input, add]);
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
      showErr(String(e));
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
