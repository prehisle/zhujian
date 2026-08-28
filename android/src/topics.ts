// 标签管理面(190,安卓精简版):标签列表 + 触摸拖排序(1c)+ 点类型入口(kind)
// + **点名字改名(514)**。
// 顺序/类型/名字都走 core 已审的 oplog topic set_field,跨端 LWW(与桌面互通,189 已验)。
//
// ⛔ **删除 / 合并 / 颜色 / 显式「新建标签」仍只桌面有,别顺手补齐**(190/258 拍的克制,
// 514 用户重申「只做重命名」):删除与合并是**破坏性且合并不可撤**,搬到触屏上要重想
// 确认形 = 新造动作表,不是「照桌面抄一份」那个成本。范围与逐项差在 backlog 用户面 44。
//
// ⭐ **改名为什么是这一批里最该先做的那件**:标签名打错字,今天在手机上**没救** ——
// 而移动端从 119 起就是全功能主力端,不是「桌面的只读伴侣」。
//
// 纪律同 panes.ts:load 取定 {space,seq},迟到响应弃;写 in-flight 禁重入(busy 置灰);
// **拖动/类型编辑/改名进行中不被动重载**(topicsInteracting → main.ts refreshActivePane 躲开,
// 免远端刷新把正在拖/正在填的行从脚下拆掉)。
import {
  getCurrentSpace,
  listTasks,
  listTopicsFull,
  reorderTopic,
  setTopicKind,
  updateTopic,
  type TopicTreeItem,
} from "./api";
import { t } from "./i18n";
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
let renameId: string | null = null; // 正在改名的行(整行换成改名形,514)
let dragging = false; // 拖排序进行中

/** 拖动 / 类型编辑 / 改名进行中:远端变更不被动重载(免拆掉正在操作的行)。 */
export function topicsInteracting(): boolean {
  return dragging || kindEditId !== null || renameId !== null;
}

export async function loadTopics(): Promise<void> {
  const space = getCurrentSpace();
  const s = ++seq;
  const box = $("topics-list");
  if (!rows.length) box.innerHTML = `<p class="muted empty">${t("topics.loading")}</p>`;
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
    box.innerHTML = `<p class="empty warn-ink">${t("topics.loadFailed", { error: esc(String(err)) })}</p>`;
  }
}

function render(): void {
  const box = $("topics-list");
  if (!rows.length) {
    box.innerHTML = `<p class="muted empty">${t("topics.empty")}</p>`;
    return;
  }
  box.innerHTML = rows
    .map((tp) => {
      // 改名态:整行只剩改名 UI(手柄/计数/类型让位)——标签名可以很长,输入框要拿满整行,
      // 而 `.tk-input` 那个 8.5em 是给「类型」这种短词的。⛔ 别把两个编辑态并排渲。
      if (tp.id === renameId) {
        return `<article class="trow${busy ? " off" : ""}" data-topic="${esc(tp.id)}">
          <span class="tn-edit">
            <input class="tn-input" value="${esc(tp.title)}" placeholder="${t("topics.renamePh")}"
                   autocapitalize="off" autocomplete="off" />
            <button data-rename-save="${esc(tp.id)}">${t("topics.renameSave")}</button>
            <button data-rename-cancel="1" class="ghost">${t("topics.renameCancel")}</button>
          </span>
        </article>`;
      }
      const n = counts.get(tp.id) ?? 0;
      const editing = tp.id === kindEditId;
      const kindZone = editing
        ? `<span class="tk-edit">
             <input class="tk-input" value="${esc(tp.kind ?? "")}" placeholder="${t("topics.kindPh")}"
                    autocapitalize="off" autocomplete="off" maxlength="40" />
             <button data-kind-save="${esc(tp.id)}">${t("topics.kindSave")}</button>
             <button data-kind-clear="${esc(tp.id)}" class="ghost">${t("topics.kindClear")}</button>
           </span>`
        : tp.kind
          ? `<button class="tk-badge" data-kind-edit="${esc(tp.id)}">${esc(tp.kind)}</button>`
          : `<button class="tk-add" data-kind-edit="${esc(tp.id)}">${t("topics.kindAdd")}</button>`;
      return `<article class="trow${busy ? " off" : ""}" data-topic="${esc(tp.id)}">
        <span class="thandle" data-drag="${esc(tp.id)}" aria-label="${t("topics.dragHint")}">⠿</span>
        <button class="tname" data-rename="${esc(tp.id)}" title="${t("topics.renameHint")}">${esc(tp.title)}${
          tp.color ? `<i class="tdot" style="--tc:${esc(tp.color)}"></i>` : ""
        }</button>
        <span class="tcount">${t("topics.count", { n })}</span>
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
    if (space === getCurrentSpace()) showBar(kind ? t("topics.kindSet") : t("topics.kindCleared"), true);
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

// ---- 改名(514;点名字进,Enter/存 落库,Esc/取消 退出) ----------------------
//
// ⛔ **不做前端预校验**(fail-fast 铁律):空名 / 重名 / 超长 / 不存在,core 的 `rename_topic`
// 四种各有自己的话(「主题标题不能为空」/「标签「X」已存在」/…),原样端给用户比这边
// 猜一遍准 —— 前端只拦一格「一个字没改」,那不是校验,是**别发一趟没意义的写**。
async function saveRename(id: string): Promise<void> {
  if (busy) return;
  const inp = $("topics-list").querySelector<HTMLInputElement>(".tn-input");
  const title = (inp?.value ?? "").trim();
  const before = rows.find((r) => r.id === id)?.title ?? "";
  if (title === before) {
    // 没改:直接退出编辑态,不发写(也不弹「已改名」那句假消息)。
    renameId = null;
    render();
    return;
  }
  const space = getCurrentSpace();
  busy = true;
  renameId = null; // 收编辑态(render 置灰;失败在 finally 重载恢复真相,同 saveKind)
  render();
  try {
    await updateTopic(space, id, title);
    if (space === getCurrentSpace()) showBar(t("topics.renamed"), true);
  } catch (err) {
    if (space === getCurrentSpace()) showError(String(err));
  } finally {
    busy = false;
    if (space === getCurrentSpace()) {
      await loadTopics();
      // 名字进了卡片 chip,主视图要跟着重画(同 saveKind/commitReorder)。
      void deps.refreshTimeline();
    }
  }
}

function onClick(e: Event): void {
  const el = e.target as HTMLElement;
  const renameFor = el.closest<HTMLElement>("[data-rename]")?.dataset.rename;
  if (renameFor) {
    if (busy || deps.isSwitching()) return;
    renameId = renameFor;
    kindEditId = null; // 两个编辑态互斥:同一行不会既在改名又在填类型
    render();
    const inp = $("topics-list").querySelector<HTMLInputElement>(".tn-input");
    inp?.focus();
    inp?.select();
    return;
  }
  const renameSaveId = el.closest<HTMLElement>("[data-rename-save]")?.dataset.renameSave;
  if (renameSaveId) {
    void saveRename(renameSaveId);
    return;
  }
  if (el.closest("[data-rename-cancel]")) {
    renameId = null;
    render();
    return;
  }
  const editId = el.closest<HTMLElement>("[data-kind-edit]")?.dataset.kindEdit;
  if (editId) {
    if (busy || deps.isSwitching()) return;
    kindEditId = editId;
    renameId = null; // 两个编辑态互斥(另一半在上面那个分支)
    render();
    $("topics-list").querySelector<HTMLInputElement>(".tk-input")?.focus();
    return;
  }
  const saveId = el.closest<HTMLElement>("[data-kind-save]")?.dataset.kindSave;
  if (saveId) {
    void saveKind(saveId);
    return;
  }
  const clearId = el.closest<HTMLElement>("[data-kind-clear]")?.dataset.kindClear;
  if (clearId) void saveKind(clearId, true);
}

function onKeydown(e: Event): void {
  const ke = e as KeyboardEvent;
  if (ke.isComposing) return; // IME 组合期的 Enter 是上屏,不是保存
  if (renameId !== null) {
    if (ke.key === "Escape") {
      renameId = null;
      render();
    } else if (ke.key === "Enter") {
      void saveRename(renameId);
    }
    return;
  }
  if (kindEditId === null) return;
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
  renameId = null;
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
