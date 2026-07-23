// 标签管理面(190,安卓精简版):标签列表 + 触摸拖排序(1c)+ 点类型入口(kind)。
// 桌面标签视图的重命名/删除/合并/颜色本轮不搬——移动端只补「排序 + 类型」两件缺口。
// 顺序/类型走 core 已审的 oplog topic set_field,跨端 LWW(与桌面互通,189 已验)。
//
// 纪律同 panes.ts:load 取定 {space,seq},迟到响应弃;写 in-flight 禁重入(busy 置灰);
// **拖动/类型编辑进行中不被动重载**(topicsInteracting → main.ts refreshActivePane 躲开,
// 免远端刷新把正在拖/正在填类型的行从脚下拆掉)。
import {
  getCurrentSpace,
  listTasks,
  listTopicsFull,
  reorderTopic,
  setTopicKind,
  type TopicTreeItem,
} from "./api";
import { $, esc, showBar, showError } from "./ui";

type Deps = {
  /** 顺序变 → 主视图卡片 chip 顺序跟随(chip 按 position 序);改类型无妨顺手重拉。 */
  refreshTimeline: () => Promise<void>;
  /** 切换编排中:屏上是旧空间的数据,一律不受理写/拖。 */
  isSwitching: () => boolean;
};

let deps: Deps;
let seq = 0;
let busy = false; // 写(排序/类型)在飞:全行置灰、禁重入
let rows: TopicTreeItem[] = [];
let counts = new Map<string, number>(); // topic id → 挂载合计(想法 + 任务)
let kindEditId: string | null = null; // 正在编辑类型的行(渲染成 input 形态)
let dragging = false; // 拖排序进行中

/** 拖动或类型编辑进行中:远端变更不被动重载(免拆掉正在操作的行)。 */
export function topicsInteracting(): boolean {
  return dragging || kindEditId !== null;
}

export async function loadTopics(): Promise<void> {
  const space = getCurrentSpace();
  const s = ++seq;
  const box = $("topics-list");
  if (!rows.length) box.innerHTML = `<p class="muted empty">读取中…</p>`;
  try {
    // 合计口径(想法 notes + 任务交叉):只显想法数会让「只挂在任务上」的标签显 0 条、误导。
    const [tree, tasks] = await Promise.all([listTopicsFull(space), listTasks(space)]);
    if (space !== getCurrentSpace() || s !== seq) return;
    const c = new Map<string, number>();
    for (const t of tree) c.set(t.id, t.notes.length);
    for (const task of tasks) for (const tp of task.topics) c.set(tp.id, (c.get(tp.id) ?? 0) + 1);
    rows = tree;
    counts = c;
    render();
  } catch (err) {
    if (space !== getCurrentSpace() || s !== seq) return;
    box.innerHTML = `<p class="empty" style="color:var(--seal)">标签读取失败:${esc(String(err))}</p>`;
  }
}

function render(): void {
  const box = $("topics-list");
  if (!rows.length) {
    box.innerHTML = `<p class="muted empty">还没有标签——在卡片上打标签,标签就会出现在这里。</p>`;
    return;
  }
  box.innerHTML = rows
    .map((t) => {
      const n = counts.get(t.id) ?? 0;
      const editing = t.id === kindEditId;
      const kindZone = editing
        ? `<span class="tk-edit">
             <input class="tk-input" value="${esc(t.kind ?? "")}" placeholder="类型(如 人名)"
                    autocapitalize="off" autocomplete="off" maxlength="40" />
             <button data-kind-save="${esc(t.id)}">存</button>
             <button data-kind-clear="${esc(t.id)}" class="ghost">清</button>
           </span>`
        : t.kind
          ? `<button class="tk-badge" data-kind-edit="${esc(t.id)}">${esc(t.kind)}</button>`
          : `<button class="tk-add" data-kind-edit="${esc(t.id)}">+ 类型</button>`;
      return `<article class="trow${busy ? " off" : ""}" data-topic="${esc(t.id)}">
        <span class="thandle" data-drag="${esc(t.id)}" aria-label="拖动排序">⠿</span>
        <span class="tname">${esc(t.title)}${
          t.color ? `<i class="tdot" style="--tc:${esc(t.color)}"></i>` : ""
        }</span>
        <span class="tcount">${n} 项</span>
        ${kindZone}
      </article>`;
    })
    .join("");
}

// ---- 类型编辑(自由文本;存/清/Esc 取消/Enter 存) --------------------------

async function saveKind(id: string, clear = false): Promise<void> {
  if (busy) return;
  const inp = $("topics-list").querySelector<HTMLInputElement>(".tk-input");
  const raw = clear ? "" : (inp?.value ?? "").trim();
  const kind = raw === "" ? null : raw;
  const space = getCurrentSpace();
  busy = true;
  kindEditId = null; // 收编辑态(render 置灰;失败在 finally 重载恢复真相)
  render();
  try {
    await setTopicKind(space, id, kind);
    if (space === getCurrentSpace()) showBar(kind ? "已设类型" : "已清类型", true);
  } catch (err) {
    if (space === getCurrentSpace()) showError(String(err));
  } finally {
    busy = false;
    if (space === getCurrentSpace()) {
      await loadTopics();
      void deps.refreshTimeline();
    }
  }
}

function onClick(e: Event): void {
  const t = e.target as HTMLElement;
  const editId = t.closest<HTMLElement>("[data-kind-edit]")?.dataset.kindEdit;
  if (editId) {
    if (busy || deps.isSwitching()) return;
    kindEditId = editId;
    render();
    $("topics-list").querySelector<HTMLInputElement>(".tk-input")?.focus();
    return;
  }
  const saveId = t.closest<HTMLElement>("[data-kind-save]")?.dataset.kindSave;
  if (saveId) {
    void saveKind(saveId);
    return;
  }
  const clearId = t.closest<HTMLElement>("[data-kind-clear]")?.dataset.kindClear;
  if (clearId) void saveKind(clearId, true);
}

function onKeydown(e: Event): void {
  const ke = e as KeyboardEvent;
  if (ke.isComposing || kindEditId === null) return; // IME 组合期的 Enter 是上屏
  if (ke.key === "Escape") {
    kindEditId = null;
    render();
  } else if (ke.key === "Enter") {
    void saveKind(kindEditId);
  }
}

// ---- 触摸拖排序(pointer;按住左侧手柄纵向拖,松手落库) ----------------------

function initDrag(box: HTMLElement): void {
  let drag: {
    id: string;
    row: HTMLElement;
    pointerId: number;
    startY: number;
    line: HTMLElement;
  } | null = null;

  // 排除拖动行后的其余行(DOM 序 == position 序)。
  const siblings = (): HTMLElement[] =>
    [...box.querySelectorAll<HTMLElement>(".trow")].filter((r) => r !== drag?.row);

  // 按指针 y(视口坐标)找插入间隙:第一个「中线在 y 之下」的行即后邻居 next,其前一
  // 行即 prev。都不满足 = 插到列尾。beforeEl 供 drop-line 定位。**判定必须用视口坐标
  // (getBoundingClientRect)** —— 指针 clientY 是视口系,而 offsetTop 是相对 #topics-list
  // 的文档系(列表在页面中部/滚动过时两者差一截),混用会指向错行。
  function targetGap(y: number): {
    prev: string | null;
    next: string | null;
    beforeEl: HTMLElement | null;
  } {
    const others = siblings();
    let idx = others.length;
    for (let i = 0; i < others.length; i++) {
      const b = others[i].getBoundingClientRect();
      if (y < b.top + b.height / 2) {
        idx = i;
        break;
      }
    }
    return {
      prev: idx > 0 ? others[idx - 1].dataset.topic! : null,
      next: idx < others.length ? others[idx].dataset.topic! : null,
      beforeEl: idx < others.length ? others[idx] : null,
    };
  }

  function positionLine(y: number): void {
    if (!drag) return;
    const { beforeEl } = targetGap(y);
    const others = siblings();
    const top = beforeEl
      ? beforeEl.offsetTop
      : others.length
        ? others[others.length - 1].offsetTop + others[others.length - 1].offsetHeight
        : 0;
    drag.line.style.top = `${top}px`;
  }

  box.addEventListener("pointerdown", (e) => {
    if (busy || deps.isSwitching() || drag) return;
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-drag]");
    if (!handle) return;
    const row = handle.closest<HTMLElement>(".trow");
    if (!row) return;
    e.preventDefault(); // 手柄上不触发原生滚动/文本选择
    dragging = true;
    const line = document.createElement("div");
    line.className = "drop-line";
    box.appendChild(line);
    drag = { id: handle.dataset.drag!, row, pointerId: e.pointerId, startY: e.clientY, line };
    row.classList.add("dragging");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* 指针非活动:忽略,timeline 上照收冒泡 */
    }
    positionLine(e.clientY);
  });

  box.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.row.style.transform = `translateY(${e.clientY - drag.startY}px)`;
    positionLine(e.clientY);
  });

  function endDrag(e: PointerEvent, cancelled: boolean): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { id, row, line } = drag;
    const { prev, next } = targetGap(e.clientY);
    row.style.transform = "";
    row.classList.remove("dragging");
    line.remove();
    drag = null;
    dragging = false;
    // prev/next 已排除拖动行本身,故只需拒「原地未动」:落点两侧恰是拖动行现有邻居。
    if (cancelled) return;
    const cur = rows.findIndex((r) => r.id === id);
    const curPrev = cur > 0 ? rows[cur - 1].id : null;
    const curNext = cur < rows.length - 1 ? rows[cur + 1].id : null;
    if (prev === curPrev && next === curNext) return; // 没挪
    void commitReorder(id, prev, next);
  }

  box.addEventListener("pointerup", (e) => endDrag(e, false));
  box.addEventListener("pointercancel", (e) => endDrag(e, true));
}

async function commitReorder(id: string, prev: string | null, next: string | null): Promise<void> {
  if (deps.isSwitching()) return;
  const space = getCurrentSpace();
  busy = true;
  render();
  try {
    await reorderTopic(space, id, prev, next);
  } catch (err) {
    if (space === getCurrentSpace()) showError(String(err));
  } finally {
    busy = false;
    if (space === getCurrentSpace()) {
      await loadTopics();
      void deps.refreshTimeline();
    }
  }
}

/** 切空间:清陈旧内容 + 作废在途查询(面随 pane 关闭,重开时现读)。 */
export function resetTopicsForSpaceChange(): void {
  seq++;
  rows = [];
  counts = new Map();
  kindEditId = null;
  dragging = false;
  $("topics-list").innerHTML = "";
}

export function initTopicsPane(d: Deps): void {
  deps = d;
  const box = $("topics-list");
  box.addEventListener("click", onClick);
  box.addEventListener("keydown", onKeydown);
  initDrag(box);
}
