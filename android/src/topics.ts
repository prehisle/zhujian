// 标签管理面(190,安卓精简版):标签列表 + 触摸拖排序(1c)+ 点类型入口(kind)
// + **点名字改名(514)** + **点色点改颜色 + 面头「新建标签」(user-44 第二刀)**
// + **删除(user-44 第三刀)**:改名态里第三枚「删除」→ 底部全局两拍确认条(cardpanel 同律,
//   不新造确认形)。core 语义 = 只删标签投影,item_topic 链随 FK 级联消失、条目本身不动。
// 全部走 core 已审的 oplog topic 命令,跨端 LWW(与桌面互通,189 已验)。
//
// ⛔ **合并仍只桌面有,别顺手补齐**(190/258 拍的克制):合并**不可撤**,搬到触屏要新造
// 「勾选多源 → 选目标」的模式态,不是「照桌面抄一份」那个成本。范围账在 backlog 用户面 44。
//
// 纪律同 panes.ts:load 取定 {space,seq},迟到响应弃;写 in-flight 禁重入(busy 置灰);
// **拖动/编辑态(类型/改名/颜色/新建)进行中不被动重载**(topicsInteracting →
// main.ts refreshActivePane 躲开,免远端刷新把正在拖/正在填的行从脚下拆掉)。
import {
  createTopic,
  deleteTopic,
  getCurrentSpace,
  listTasks,
  listTopicsFull,
  reorderTopic,
  setTopicColor,
  setTopicKind,
  updateTopic,
  type TopicTreeItem,
} from "./api";
import { t } from "./i18n";
import { $, confirmBar, esc, showBar, showError } from "./ui";

type Deps = {
  /** 顺序变 → 主视图卡片 chip 顺序跟随(chip 按 position 序);改类型无妨顺手重拉。 */
  refreshTimeline: () => Promise<void>;
  /** 切换编排中:屏上是旧空间的数据,一律不受理写/拖。 */
  isSwitching: () => boolean;
};

let deps: Deps;
let seq = 0;
let busy = false; // 写(排序/类型/名/色/建)在飞:全行置灰、禁重入
let rows: TopicTreeItem[] = [];
let counts = new Map<string, number>(); // topic id → 挂载合计(想法 + 任务)
let kindEditId: string | null = null; // 正在编辑类型的行(渲染成 input 形态)
let renameId: string | null = null; // 正在改名的行(整行换成改名形,514)
let colorEditId: string | null = null; // 正在挑颜色的行(整行换成调色板,user-44 第二刀)
let creating = false; // 「新建标签」输入行开着(渲在列表顶,user-44 第二刀)
let dragging = false; // 拖排序进行中

// 调色板:与桌面 src/tag-color.ts 的 TAG_COLORS **同一组八色、同一顺序**,加色/改色两边一起动
// (没有闸压这两份 —— 色值存库存的是 hex,调色板漂了最坏是两端候选不同,已挂色的标签不受影响)。
// 避开纯朱红(--seal 是截止/新生脉冲的强调色,别撞)。⛔ 颜色名刻意不带:触屏没有 tooltip,
// 桌面那份的 name 字段今天也无人读。
const PALETTE = [
  "#c0563f", "#cc8b3c", "#7f8b3a", "#3f8272",
  "#3f7a99", "#6b5b95", "#a8577e", "#7a7166",
];

/** 拖动 / 编辑态(类型/改名/颜色/新建)进行中:远端变更不被动重载(免拆掉正在操作的行)。 */
export function topicsInteracting(): boolean {
  return dragging || kindEditId !== null || renameId !== null || colorEditId !== null || creating;
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
  if (!rows.length && !creating) {
    box.innerHTML = `<p class="muted empty">${t("topics.empty")}</p>`;
    return;
  }
  // 新建行(user-44 第二刀):渲在列表顶,与改名行同形(.tn-edit)。第一个标签也从这儿建
  // (rows 为空 + creating 时只渲它,不渲空态)。
  const createRow = creating
    ? `<article class="trow${busy ? " off" : ""}" data-create-row="1">
        <span class="tn-edit">
          <input class="tn-input" placeholder="${t("topics.newPh")}"
                 autocapitalize="off" autocomplete="off" />
          <button data-create-save="1">${t("topics.newSave")}</button>
          <button data-create-cancel="1" class="ghost">${t("topics.newCancel")}</button>
        </span>
      </article>`
    : "";
  box.innerHTML =
    createRow +
    rows
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
            <button data-del="${esc(tp.id)}" class="tn-del">${t("topics.deleteBtn")}</button>
          </span>
        </article>`;
        }
        // 颜色编辑态:整行换成调色板(8 色 + 无色 + 取消),点色块即写(saveColor)。
        // current 标在当前色上;「无色」块在没挂色时标 current。
        if (tp.id === colorEditId) {
          const cur = tp.color ?? null;
          const swatches = PALETTE.map(
            (hex) =>
              `<button class="tc-swatch${cur === hex ? " current" : ""}" data-swatch="${hex}"
                     style="--tc:${hex}" aria-label="${hex}"></button>`,
          ).join("");
          return `<article class="trow${busy ? " off" : ""}" data-topic="${esc(tp.id)}">
          <span class="tc-edit">
            ${swatches}
            <button class="tc-swatch none${cur === null ? " current" : ""}" data-swatch="">${t("topics.colorNone")}</button>
            <button class="tc-cancel" data-color-cancel="1">${t("topics.colorCancel")}</button>
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
        // 色钮常驻(无色渲空圈)—— 无色标签也要有改色入口;.tdot 记号与筛选 pill 的 .fdot 共形。
        return `<article class="trow${busy ? " off" : ""}" data-topic="${esc(tp.id)}">
        <span class="thandle" data-drag="${esc(tp.id)}" aria-label="${t("topics.dragHint")}">⠿</span>
        <button class="tname" data-rename="${esc(tp.id)}" title="${t("topics.renameHint")}">${esc(tp.title)}</button>
        <button class="tcolor" data-color="${esc(tp.id)}" aria-label="${t("topics.colorHint")}">${
          tp.color ? `<i class="tdot" style="--tc:${esc(tp.color)}"></i>` : `<i class="tdot none"></i>`
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

// ---- 删除(user-44 第三刀;改名态里的「删除」→ 底部两拍确认条) ---------------
//
// 第一拍先把改名态收掉再弹确认条:取消 / 6s 超时自动收之后行已是常态,零残留;
// 也免得确认条挂着时用户又去点「存」造出两个在飞语境。话术带名字与挂载数
// (0 挂载用简版 —— 「0 项」是句空话),但**不做前端预拦**:挂多少都能删,
// core 语义就是链级联摘掉、条目不动。

function askDelete(id: string): void {
  if (busy || deps.isSwitching()) return;
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  const n = counts.get(id) ?? 0;
  const space = getCurrentSpace();
  renameId = null;
  render();
  confirmBar(
    n > 0
      ? t("topics.deleteQ", { name: row.title, n })
      : t("topics.deleteQEmpty", { name: row.title }),
    t("topics.deleteYes"),
    () => void doDelete(space, id),
  );
}

async function doDelete(space: string, id: string): Promise<void> {
  // 第二拍复核语境未变(cardpanel 同律):确认条挂着时切了空间/进了别的写,旧确认作废。
  if (busy || deps.isSwitching() || space !== getCurrentSpace()) return;
  busy = true;
  render();
  try {
    await deleteTopic(space, id);
    if (space === getCurrentSpace()) showBar(t("topics.deleted"), true);
  } catch (err) {
    if (space === getCurrentSpace()) showError(String(err));
  } finally {
    busy = false;
    if (space === getCurrentSpace()) {
      await loadTopics();
      // 卡片 chip / 筛选 pills 都挂着这枚标签,删了要跟着摘(refreshTimeline 唯一重拉处)。
      void deps.refreshTimeline();
    }
  }
}

// ---- 颜色(user-44 第二刀;点色点开调色板,点色块即写) ----------------------
//
// 与 saveKind 同构:busy 置灰、先收编辑态、失败 showError、finally 重载恢复真相。
// 改色后 refreshTimeline 必须跟 —— 卡片 chip / 筛选 pill / 打标签面三处都在读 color。
async function saveColor(id: string, hex: string | null): Promise<void> {
  if (busy) return;
  const space = getCurrentSpace();
  busy = true;
  colorEditId = null;
  render();
  try {
    await setTopicColor(space, id, hex);
    if (space === getCurrentSpace()) showBar(hex ? t("topics.colorSet") : t("topics.colorCleared"), true);
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

// ---- 新建标签(user-44 第二刀;面头钮开输入行,Enter/「建」落库) --------------
//
// ⛔ 不做前端预校验(同 saveRename 那条纪律):重名/超长交给 core 的 create_topic 原样说。
// 只拦空名 —— 那不是校验,是别发一趟必拒的写(空名 core 必拒);拦法 = 留在原地把焦点
// 还给输入框,不弹错(输入框还空着,用户自己看得懂)。
async function doCreate(): Promise<void> {
  if (busy) return;
  const inp = $("topics-list").querySelector<HTMLInputElement>(".tn-input");
  const title = (inp?.value ?? "").trim();
  if (!title) {
    inp?.focus();
    return;
  }
  const space = getCurrentSpace();
  busy = true;
  creating = false; // 收编辑态(失败时输入丢了要重输 —— 与改名失败同一代价,一致性优先)
  render();
  try {
    await createTopic(space, title);
    if (space === getCurrentSpace()) showBar(t("topics.created"), true);
  } catch (err) {
    if (space === getCurrentSpace()) showError(String(err));
  } finally {
    busy = false;
    if (space === getCurrentSpace()) {
      await loadTopics();
      // 新标签要进筛选条的全量 pills(计 0 也显)——那份数据只在 refreshTimeline 里重拉。
      void deps.refreshTimeline();
    }
  }
}

function startCreate(): void {
  if (busy || deps.isSwitching()) return;
  creating = true;
  renameId = null;
  kindEditId = null;
  colorEditId = null; // 四个编辑态互斥
  render();
  const inp = $("topics-list").querySelector<HTMLInputElement>(".tn-input");
  inp?.focus();
}

function onClick(e: Event): void {
  const el = e.target as HTMLElement;
  const renameFor = el.closest<HTMLElement>("[data-rename]")?.dataset.rename;
  if (renameFor) {
    if (busy || deps.isSwitching()) return;
    renameId = renameFor;
    kindEditId = null; // 四个编辑态互斥:同一时刻只开一处
    colorEditId = null;
    creating = false;
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
  const delId = el.closest<HTMLElement>("[data-del]")?.dataset.del;
  if (delId) {
    askDelete(delId);
    return;
  }
  const colorFor = el.closest<HTMLElement>("[data-color]")?.dataset.color;
  if (colorFor) {
    if (busy || deps.isSwitching()) return;
    colorEditId = colorFor;
    renameId = null; // 互斥(同上)
    kindEditId = null;
    creating = false;
    render();
    return;
  }
  const swatch = el.closest<HTMLElement>("[data-swatch]");
  if (swatch) {
    // 行 id 从宿主行取(色块行渲在 data-topic 行里);"" = 无色块 ⇒ 清色。
    const rowId = swatch.closest<HTMLElement>(".trow")?.dataset.topic;
    if (rowId) void saveColor(rowId, swatch.dataset.swatch || null);
    return;
  }
  if (el.closest("[data-color-cancel]")) {
    colorEditId = null;
    render();
    return;
  }
  if (el.closest("[data-create-save]")) {
    void doCreate();
    return;
  }
  if (el.closest("[data-create-cancel]")) {
    creating = false;
    render();
    return;
  }
  const editId = el.closest<HTMLElement>("[data-kind-edit]")?.dataset.kindEdit;
  if (editId) {
    if (busy || deps.isSwitching()) return;
    kindEditId = editId;
    renameId = null; // 互斥(同上)
    colorEditId = null;
    creating = false;
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
  if (creating) {
    if (ke.key === "Escape") {
      creating = false;
      render();
    } else if (ke.key === "Enter") {
      void doCreate();
    }
    return;
  }
  if (renameId !== null) {
    if (ke.key === "Escape") {
      renameId = null;
      render();
    } else if (ke.key === "Enter") {
      void saveRename(renameId);
    }
    return;
  }
  if (colorEditId !== null) {
    // 调色板没有输入框,只认 Esc 退出(有实体键盘时;触屏走「取消」钮)。
    if (ke.key === "Escape") {
      colorEditId = null;
      render();
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

  // 排除拖动行后的其余行(DOM 序 == position 序)。⚠ 只认带 data-topic 的行 ——
  // 新建行(data-create-row)也是 .trow 但不是标签,混进邻居会让 `dataset.topic!`
  // 拿到 undefined 当锚点发给 reorder。
  const siblings = (): HTMLElement[] =>
    [...box.querySelectorAll<HTMLElement>(".trow")].filter((r) => r !== drag?.row && !!r.dataset.topic);

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
  colorEditId = null;
  creating = false;
  dragging = false;
  $("topics-list").innerHTML = "";
}

export function initTopicsPane(d: Deps): void {
  deps = d;
  const box = $("topics-list");
  box.addEventListener("click", onClick);
  box.addEventListener("keydown", onKeydown);
  $("topics-new").addEventListener("click", startCreate);
  initDrag(box);
}
