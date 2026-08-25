import { invoke } from "./space";
import { type BoardColumn, columnName, loadBoardColumns } from "./board-columns";
import type { View, ViewCtx } from "./notebook";
import { type TaskItem, PRIORITY_LABEL, dueLabel, dueState, localToday, when } from "./tasktime";
import { copyButton } from "./clipboard";
import { toastAction } from "./toast";
import { armDismiss, registerViewKeys } from "./hotkey-menu";
import { TAG_COLORS } from "./tag-color";
import { t } from "./i18n";
import "./topics.css";

// 标签视图。底层数据是 topics/item_topic(命令名、表名沿用 topic),对用户重定位为
// 「标签」——轻量分类 + 下钻聚合(挂该标签的灵感 + 任务),不再承诺「知识结构」。早期
// 的 summary(备注)字段已于迁移 0015 物理删除。
// Mirror of the Rust contract (lib.rs `list_topics_full`): a tag with the filed
// ideas under it.
type TopicNote = { id: string; content: string; created_at: string };
type TopicTree = {
  id: string;
  title: string;
  color: string | null;
  /** 手动排序键(0031 frindex)或 null=未定序 —— 后端已按它排序,拖动改它。 */
  position: string | null;
  /** 标签类型自由文本(0031)或 null=无类型 —— 可标「人名」等,供日后按类型筛选。 */
  kind: string | null;
  notes: TopicNote[];
};

// 任务的列名(下钻态只读展示用)。**B-f 第 1 段起从库里来** —— 列可改名 / 增删,这里
// 曾经是 board.ts 那份四值表的**第二份复制品**(连字典键都复制了一份 topics.col*),
// 现在两处共用 `board-columns.ts` 的 columnName()。⛔ 别再抄第三份。
let colName = new Map<string, string>();

// ---- small DOM helper (same shape as inbox.ts) -----------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

// ---- 前缀分组(纯视觉层级)---------------------------------------------------
// 标签名带 `/` 时(如 zhujian/同步),若存在与首段同名的父标签,该行收进父标签下方的子
// 容器(.topic-kids:缩进 + 一条左导轨)、只显后缀,视觉上「父子成一组」。语义仍是平的:
// 分组只影响列表排版,筛选/计数/重命名/合并/删除全不感知层级(看板筛父标签不含子;一条
// 内容两边都该算就打两个标签——M:N 本来就支持)。只按第一段分一层视觉层级,多级斜杠不再
// 细分;没有同名父标签的 a/b 保持平铺显全名(不造假组头)。
type TopicGroup = { parent: TopicTree; children: { topic: TopicTree; label: string }[] };
function groupByPrefix(trees: TopicTree[]): TopicGroup[] {
  const titles = new Set(trees.map((t) => t.title));
  const childrenOf = new Map<string, TopicTree[]>();
  const tops: TopicTree[] = [];
  for (const t of trees) {
    const i = t.title.indexOf("/");
    // 首尾斜杠("/x"、"x/")不算前缀写法,照平铺走。
    const prefix = i > 0 && i < t.title.length - 1 ? t.title.slice(0, i) : null;
    if (prefix !== null && titles.has(prefix)) {
      const arr = childrenOf.get(prefix);
      if (arr) arr.push(t);
      else childrenOf.set(prefix, [t]);
    } else {
      tops.push(t);
    }
  }
  // 子标签保持后端给的相对顺序(最近变动在前,同顶层列表一个排序原则)。
  return tops.map((t) => ({
    parent: t,
    children: (childrenOf.get(t.title) ?? []).map((c) => ({ topic: c, label: c.title.slice(t.title.length + 1) })),
  }));
}

// Which tags are expanded (collapse/expand state). Module scope so leaving the view
// and coming back keeps the same rows open — a UI preference, not data.
const expanded = new Set<string>();

// 哪些父标签把「子标签组」收起来了(0031 前缀分组的折叠态)。默认展开(不在集里 = 显子行);
// 加进来 = 收起该父下方的 .topic-kids。同 expanded 提到模块级(跨视图切换存活的 UI 偏好,
// 非数据)。只对有子标签的父行有意义;合并态强制展开(要选子标签),故那时不套用。
const collapsedKids = new Set<string>();

// List scroll offset, captured on unmount and restored on the next mount so a view
// switch returns you to where you were reading (same rationale as inbox.ts savedScroll).
let savedScroll = 0;

const SKELETON = `
  <header data-tauri-drag-region>
    <h1>${t("topics.header")}</h1>
    <button id="new-toggle" class="hbtn" type="button">${t("topics.newTag")} <kbd class="k">N</kbd></button>
    <button id="merge-toggle" class="hbtn" type="button"><span class="lbl">${t("topics.mergeTags")}</span> <kbd class="k">M</kbd></button>
  </header>
  <div id="newform" class="newform" hidden>
    <input id="nt-title" class="nt-title" type="text" placeholder="${t("topics.namePlaceholder")}" />
    <button id="nt-create" class="mb-btn go" type="button">${t("topics.create")}</button>
    <button id="nt-cancel" class="mb-btn" type="button">${t("topics.cancel")}</button>
    <span id="nt-err" class="nt-err"></span>
  </div>
  <main id="list"></main>
  <footer id="mergebar" class="mergebar" hidden>
    <span id="mb-hint" class="mb-hint"></span>
    <div id="mb-chips" class="mb-chips"></div>
    <input id="mb-rename" class="mb-rename" type="text" placeholder="${t("topics.mergeRenamePlaceholder")}" hidden />
    <button id="mb-merge" class="mb-btn go" type="button" disabled>${t("topics.merge")}</button>
    <button id="mb-cancel" class="mb-btn" type="button">${t("topics.cancel")}</button>
  </footer>
`;

export function mount(root: HTMLElement, _ctx: ViewCtx): View {
  const view = el("div", { className: "v-topics view" });
  view.innerHTML = SKELETON;
  root.replaceChildren(view);

  const list = view.querySelector("#list") as HTMLElement;
  const newToggle = view.querySelector("#new-toggle") as HTMLButtonElement;
  const newform = view.querySelector("#newform") as HTMLElement;
  const ntTitle = view.querySelector("#nt-title") as HTMLInputElement;
  const ntCreate = view.querySelector("#nt-create") as HTMLButtonElement;
  const ntCancel = view.querySelector("#nt-cancel") as HTMLButtonElement;
  const ntErr = view.querySelector("#nt-err") as HTMLElement;
  const mergeToggle = view.querySelector("#merge-toggle") as HTMLButtonElement;
  const mergebar = view.querySelector("#mergebar") as HTMLElement;
  const mbHint = view.querySelector("#mb-hint") as HTMLElement;
  const mbChips = view.querySelector("#mb-chips") as HTMLElement;
  const mbRename = view.querySelector("#mb-rename") as HTMLInputElement;
  const mbMerge = view.querySelector("#mb-merge") as HTMLButtonElement;
  const mbCancel = view.querySelector("#mb-cancel") as HTMLButtonElement;

  // ---- loaded data (refreshed together) ------------------------------------
  let trees: TopicTree[] = []; // every tag (incl. empties), notes attached
  let tasksByTopic = new Map<string, TaskItem[]>(); // tag id -> its active tasks

  // Restore the saved scroll offset once, after the first mount render (see savedScroll).
  let restorePending = true;

  function renderCenter(big: string, detail: string): void {
    list.replaceChildren(
      el("div", { className: "center" }, [
        el("div", { className: "big", textContent: big }),
        el("div", { textContent: detail }),
      ]),
    );
  }

  // 只给**读取**失败用(refresh 的 catch;那里会清 lastSig,否则 refocus 指纹短路会把
  // 错误页永久钉在屏上)。卡级操作失败一律就地/回执报错,绝不整页换错误页。
  function renderError(message: string): void {
    const retry = el("button", { className: "mb-btn", textContent: t("topics.retry") });
    retry.addEventListener("click", () => void refresh());
    list.replaceChildren(
      el("div", { className: "center" }, [
        el("div", { className: "big", textContent: t("topics.loadFailed") }),
        el("div", { className: "err-box", textContent: message }),
        retry,
      ]),
    );
  }

  // ---- drag-reorder state (0031 1c) ----------------------------------------
  // 手动排序:拖标签行调顺序。只在**同层兄弟**间重排(顶层行之间 / 同一父下的子行之间)
  // —— 同层的 DOM 渲染序 == position 序(后端按 position 排,groupByPrefix 在层内保序),
  // 故 key_between(前邻.position, 后邻.position) 恒合法(前 < 后);跨层拖放忽略,避免
  // 「父在子后」这类 position 逆序把 key_between 撞 Err。拖动只写被拖那一枚(一条 op)。
  let draggingTopicId: string | null = null;

  // ---- merge mode state ----------------------------------------------------
  // Manual tag merge: pick 2+ tags, designate one survivor, the rest fold in.
  let merging = false;
  const selected = new Set<string>();
  let survivor: string | null = null;
  let confirming = false; // merge button waits for a second, confirming click
  let renameFor: string | null = null; // which survivor the rename box was last primed for
  const sections = new Map<string, HTMLElement>(); // live id -> section element (list view only)
  let titles = new Map<string, string>(); // id -> current title (for the hint/rename)

  // One tag row in the flat list: a clickable head (title + counts) that EXPANDS the
  // tag inline (collapse/expand, not a drill into a separate sub-page) to show its ideas
  // + tasks read-only. In merge mode the head toggles selection instead. Outside merge
  // mode the head also carries 重命名 / 删除 (manual maintenance).
  // `label` 是列表里显示的名字(子标签只显后缀),`child` 只标记子行(缩进/左导轨由外层
  // .topic-kids 容器给,见 renderList)+ 悬停全名——重命名/合并/chips 等一切别处仍用全名
  // topic.title。
  function section(topic: TopicTree, label: string, child: boolean, kidCount = 0): HTMLElement {
    const sec = el("section", { className: child ? "topic child" : "topic" });
    sec.dataset.topicId = topic.id; // 拖排序落点据它反查 id / 判同层
    const tasks = tasksByTopic.get(topic.id) ?? [];

    const check = el("span", { className: "check", textContent: "" }); // ✓ (merge mode)
    // 拖动手柄(仅非合并态出现;draggable 只挂它,避开 head 里的按钮/展开点击冲突)。
    const handle = el("span", { className: "topic-drag", textContent: "⠿", title: t("topics.dragHint") });
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
      if (merging) {
        e.preventDefault();
        return;
      }
      draggingTopicId = topic.id;
      sec.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    handle.addEventListener("dragend", () => {
      draggingTopicId = null;
      sec.classList.remove("dragging");
      clearDropHints();
    });
    const caret = el("span", { className: "topic-caret", textContent: "▸" });
    // 色点:有色标签才现身(反映当前颜色,和看板 chip 一致);无色不占位。
    const dot = el("span", { className: "topic-dot" });
    if (topic.color) {
      dot.style.setProperty("--tag-color", topic.color);
      dot.classList.add("on");
    }
    const titleEl = el("span", { className: "topic-title", textContent: label });
    if (child) titleEl.title = topic.title; // 悬停可见全名(后缀脱离上下文时的兜底)
    // 类型徽标:有类型才现身(如「人名」),供一眼识别标签类别。
    const kindBadge = el("span", { className: "topic-kind", textContent: topic.kind ?? "" });
    if (topic.kind) kindBadge.classList.add("on");
    const countEl = el("span", {
      className: "topic-count",
      textContent: t("topics.counts", { ideas: topic.notes.length, tasks: tasks.length }),
    });
    const keepBadge = el("span", { className: "keep-badge", textContent: t("topics.keep") });

    // 子标签折叠开关(仅有子标签的父行、非合并态):收起/展开该父下方的 .topic-kids 组。
    // 状态在模块级 collapsedKids(跨视图切换存活,同 expanded)。点击直接翻邻接的 kids 容器
    // 的 .collapsed 类,不整表重建(省一次重画、不跳滚动);合并态要选子标签故不出此钮。
    let kidsToggle: HTMLElement | null = null;
    if (kidCount > 0 && !merging) {
      const collapsed = collapsedKids.has(topic.id);
      const chev = el("span", { className: "kt-chev", textContent: collapsed ? "▸" : "▾" });
      kidsToggle = el("button", { className: "topic-kids-toggle", title: collapsed ? t("topics.expandKids") : t("topics.collapseKids") }, [
        chev,
        document.createTextNode(` ${t("topics.kidCount", { n: kidCount })}`),
      ]);
      kidsToggle.addEventListener("click", (e) => {
        e.stopPropagation(); // 别触发 head 的「展开本标签内容」
        const now = !collapsedKids.has(topic.id);
        if (now) collapsedKids.add(topic.id);
        else collapsedKids.delete(topic.id);
        const kids = sec.nextElementSibling;
        if (kids instanceof HTMLElement && kids.classList.contains("topic-kids")) {
          kids.classList.toggle("collapsed", now);
        }
        chev.textContent = now ? "▸" : "▾";
        kidsToggle!.title = now ? t("topics.expandKids") : t("topics.collapseKids");
      });
    }

    const head = el("div", { className: "topic-head" }, [
      check,
      handle,
      caret,
      dot,
      titleEl,
      kindBadge,
      countEl,
      ...(kidsToggle ? [kidsToggle] : []),
      keepBadge,
    ]);

    // 拖排序落点:只认同层兄弟(同 parentElement);按指针在目标行上/下半决定插前/插后。
    sec.addEventListener("dragover", (e) => {
      if (draggingTopicId === null || draggingTopicId === topic.id) return;
      if (sec.parentElement !== sections.get(draggingTopicId)?.parentElement) return; // 跨层不收
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = sec.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearDropHints();
      sec.classList.add(after ? "drop-after" : "drop-before");
    });
    sec.addEventListener("dragleave", () => {
      sec.classList.remove("drop-before", "drop-after");
    });
    sec.addEventListener("drop", (e) => {
      if (draggingTopicId === null || draggingTopicId === topic.id) return;
      const draggedSec = sections.get(draggingTopicId);
      if (!draggedSec || sec.parentElement !== draggedSec.parentElement) return;
      e.preventDefault();
      const after = sec.classList.contains("drop-after");
      clearDropHints();
      void dropReorder(draggingTopicId, topic.id, after);
    });

    // A small head button that never triggers the head's drill/select click.
    const tbtn = (label: string, onClick: () => void, danger = false) => {
      const b = el("button", {
        className: danger ? "tbtn danger" : "tbtn",
        textContent: label,
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    const actions = el("div", { className: "topic-actions" });
    // 动作区默认只在悬停本行时现身(topics.css:opacity 0 → 1)。但它一旦就地换成
    // **要交互的东西**(类型输入 / 调色板 / 删除确认 / 失败提示),那条规则就把它们
    // 也一起藏了:鼠标离开这一行,正在填的输入框、刚报出来的错就当场隐形(键盘焦点
    // 还在里面,打字照样进得去 —— 看不见的输入框)。故非默认态一律加 `.open` 钉住
    // 可见;`showActions()` 是唯一的还原点。**每处都必须表态**:换内容只走 swapActions,
    // 别再直接 actions.replaceChildren(漏一处就是漏一种隐形态)。
    const swapActions = (open: boolean, ...nodes: (Node | string)[]) => {
      actions.classList.toggle("open", open);
      actions.replaceChildren(...nodes);
    };
    const showActions = () =>
      swapActions(
        false,
        tbtn(t("topics.color"), openColor),
        tbtn(t("topics.kind"), openKind),
        tbtn(t("topics.rename"), openEdit),
        tbtn(t("topics.delete"), confirmDelete, true),
      );

    // 类型:一个自由文本输入(默认填当前类型),就地替换动作区。写入走 set_topic_kind
    // (空 = 清类型)。类型是元数据,供日后按类型筛选(如「人名」)。
    // 行内操作失败:动作区就地报错(整页换错误页会被 refocus 指纹短路钉死,且把
    // 一次瞬时失败放大成全视图不可用——ui-audit P0 #6 与 inbox/board 同规)。
    function showOpError(e: unknown): void {
      swapActions(
        true,
        el("span", { className: "te-err", textContent: t("topics.opFailed", { msg: String(e) }) }),
        tbtn(t("topics.gotIt"), showActions),
      );
    }

    async function saveKind(value: string | null): Promise<void> {
      try {
        await invoke("set_topic_kind", { id: topic.id, kind: value });
      } catch (e) {
        showOpError(e);
        return;
      }
      await refresh();
    }
    function openKind(): void {
      const input = el("input", {
        className: "tk-input",
        value: topic.kind ?? "",
        placeholder: t("topics.kindPlaceholder"),
      }) as HTMLInputElement;
      input.addEventListener("keydown", (e) => {
        if (e.isComposing) return; // IME 组合期的 Enter 是上屏(ui-audit P0 #1)
        if (e.key === "Enter") {
          e.preventDefault();
          void saveKind(input.value);
        } else if (e.key === "Escape") {
          showActions();
        }
      });
      swapActions(
        true,
        input,
        tbtn(t("topics.save"), () => void saveKind(input.value)),
        tbtn(t("topics.clear"), () => void saveKind(null)),
        tbtn(t("topics.cancel"), showActions),
      );
      input.focus();
      input.select();
    }

    // 颜色:调色板行(一排色块 + 无色),就地替换动作区(同「删除?」的 in-place swap)。
    // 点色块即写入并刷新——手选热标签,默认无色。
    async function setColor(hex: string | null): Promise<void> {
      try {
        await invoke("set_topic_color", { id: topic.id, color: hex });
      } catch (e) {
        showOpError(e);
        return;
      }
      await refresh();
    }
    function openColor(): void {
      const swatch = (hex: string | null): HTMLElement => {
        const b = el("button", {
          className: hex ? "color-swatch" : "color-swatch none",
          title: hex ?? t("topics.noColor"),
          textContent: hex ? "" : t("topics.none"),
        });
        if (hex) b.style.setProperty("--tag-color", hex);
        if ((topic.color ?? null) === hex) b.classList.add("current");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          void setColor(hex);
        });
        return b;
      };
      swapActions(
        true,
        el("div", { className: "color-row" }, [...TAG_COLORS.map((c) => swatch(c.hex)), swatch(null)]),
        tbtn(t("topics.done"), showActions),
      );
    }

    function confirmDelete(): void {
      // 确认态响应 Esc/点别处收起(ui-audit P1 #12,armDismiss 同一套手势);teardown
      // 走 mount 级 confirmOff 单值(codex M3:重画时闭包局部的 off 会随旧行泄漏)。
      disarmConfirm();
      const off = armDismiss(actions, () => {
        confirmOff = null; // armDismiss 已自拆:只归零
        showActions();
      });
      confirmOff = off;
      swapActions(
        true,
        el("span", { className: "td-q", textContent: t("topics.deleteConfirm") }),
        tbtn(t("topics.cancel"), () => {
          disarmConfirm();
          showActions();
        }),
        tbtn(t("topics.delete"), () => {
          disarmConfirm();
          void doDelete();
        }, true),
      );
    }
    async function doDelete(): Promise<void> {
      try {
        await invoke("delete_topic", { id: topic.id });
      } catch (e) {
        showOpError(e);
        return;
      }
      await refresh();
    }
    showActions();
    head.append(actions);

    // Collapse/expand inline — no drill into a separate page, no back button.
    function applyExpanded(): void {
      const open = !merging && expanded.has(topic.id); // merge mode shows a clean flat list
      caret.textContent = open ? "▾" : "▸";
      sec.classList.toggle("open", open);
      const existing = sec.querySelector(".topic-body");
      if (open && !existing) sec.append(buildBody(topic, tasks));
      else if (!open && existing) existing.remove();
    }

    head.addEventListener("click", () => {
      if (merging) {
        toggleSelect(topic.id);
        return;
      }
      if (expanded.has(topic.id)) expanded.delete(topic.id);
      else expanded.add(topic.id);
      applyExpanded();
    });

    // ---- inline rename — replaces the row while open ----
    function openEdit(): void {
      const titleInput = el("input", { className: "te-title", value: topic.title }) as HTMLInputElement;
      const err = el("span", { className: "te-err" });
      const save = async () => {
        try {
          await invoke("update_topic", { id: topic.id, title: titleInput.value });
        } catch (e) {
          err.textContent = String(e);
          return;
        }
        await refresh();
      };
      titleInput.addEventListener("keydown", (e) => {
        if (e.isComposing) return; // IME 组合期的 Enter 是上屏,不是保存(ui-audit P0 #1)
        if (e.key === "Enter") {
          e.preventDefault();
          void save();
        }
      });
      sec.replaceChildren(
        el("div", { className: "topic-edit" }, [
          el("span", { className: "te-label", textContent: t("topics.renameTitle") }),
          titleInput,
          el("div", { className: "te-actions" }, [
            el("button", { className: "mb-btn", textContent: t("topics.cancel"), onclick: () => void refresh() }),
            el("button", { className: "mb-btn go", textContent: t("topics.save"), onclick: () => void save() }),
            err,
          ]),
        ]),
      );
      titleInput.focus();
      titleInput.select();
    }

    sec.replaceChildren(head);
    applyExpanded(); // restore expanded state across a refresh
    return sec;
  }

  // ---- expanded body: a tag's ideas + tasks, read-only (collapse/expand) ----
  // One read-only task row in an expanded tag (column + due/priority + 复制). No
  // click-to-jump — the tag view only browses; act on tasks over on the board.
  function taskRow(task: TaskItem, today: string): HTMLElement {
    // 列名查不到 = 这张卡的列凭空没了(FK 保证不可达)。⛔ 不静默显 id,响亮抛。
    const cn = colName.get(task.status);
    if (cn === undefined) throw new Error(`task ${task.id} sits in unknown column ${task.status}`);
    const meta: Node[] = [el("span", { className: "dtask-col", textContent: cn })];
    if (task.due_on) {
      const st = dueState(task.due_on, today);
      meta.push(el("span", { className: `dtask-due ${st}`, textContent: dueLabel(task.due_on, today) }));
    }
    if (task.priority) {
      meta.push(el("span", { className: `dtask-pri p${task.priority}`, textContent: t("topics.priority", { label: PRIORITY_LABEL[task.priority] }) }));
    }
    const card = el("article", { className: "dtask" }, [
      el("p", { className: "dtask-title", textContent: task.title }),
      el("div", { className: "dtask-meta" }, meta),
    ]);
    card.append(copyButton(task.title, "dtask-copy"));
    return card;
  }

  // The inline body shown when a tag row is expanded: its filed ideas + tagged tasks.
  function buildBody(topic: TopicTree, tasks: TaskItem[]): HTMLElement {
    const today = localToday();
    const noteCards = topic.notes.length
      ? topic.notes.map((n) =>
          el("article", { className: "tnote" }, [
            el("p", { className: "tnote-text", textContent: n.content }),
            el("time", { className: "tnote-time", textContent: when(n.created_at) }),
          ]),
        )
      : [el("div", { className: "drill-empty", textContent: t("topics.noIdeas") })];
    const notesSec = el("section", { className: "drill-sec" }, [
      el("h2", { className: "drill-h", textContent: t("topics.ideasCount", { n: topic.notes.length }) }),
      el("div", { className: "drill-notes" }, noteCards),
    ]);
    const taskCards = tasks.length
      ? tasks.map((t) => taskRow(t, today))
      : [el("div", { className: "drill-empty", textContent: t("topics.noTasks") })];
    const tasksSec = el("section", { className: "drill-sec" }, [
      el("h2", { className: "drill-h", textContent: t("topics.tasksCount", { n: tasks.length }) }),
      el("div", { className: "drill-tasks" }, taskCards),
    ]);
    return el("div", { className: "topic-body" }, [notesSec, tasksSec]);
  }

  // Clear any drop indicator across all live rows (called on dragover re-hint / drop / end).
  function clearDropHints(): void {
    for (const sec of sections.values()) sec.classList.remove("drop-before", "drop-after");
  }

  // Land `dragId` next to `targetId` (same-level siblings). Neighbours are computed from
  // the DOM sibling order within the shared parent (== position order in-layer), so
  // key_between(prev.pos, next.pos) on the backend is always valid. One key write, one op.
  async function dropReorder(dragId: string, targetId: string, after: boolean): Promise<void> {
    const target = sections.get(targetId);
    if (!target) return;
    const container = target.parentElement;
    if (!container) return;
    // 同层兄弟按 DOM 顺序(= position 顺序);去掉被拖行本身后定位。
    const sibIds = ([...container.children] as HTMLElement[])
      .filter((c) => c.matches("section.topic") && c.dataset.topicId)
      .map((c) => c.dataset.topicId as string)
      .filter((id) => id !== dragId);
    const tIdx = sibIds.indexOf(targetId);
    if (tIdx < 0) return;
    const prevId = after ? targetId : (sibIds[tIdx - 1] ?? null);
    const nextId = after ? (sibIds[tIdx + 1] ?? null) : targetId;
    // 落回原位(前后邻都没变)= no-op,不发命令(否则白写一枚 position key、白发
    // 一条同步 op——LWW 无害但脏)。当前邻居按含被拖行的 DOM 顺序取。
    const all = ([...container.children] as HTMLElement[])
      .filter((c) => c.matches("section.topic") && c.dataset.topicId)
      .map((c) => c.dataset.topicId as string);
    const dIdx = all.indexOf(dragId);
    if ((all[dIdx - 1] ?? null) === prevId && (all[dIdx + 1] ?? null) === nextId) return;
    try {
      await invoke("reorder_topic", { id: dragId, prevId, nextId });
    } catch (e) {
      // 操作失败走回执,不整页换错误页(拖动没有稳定的行内报错锚点)。
      toastAction(t("topics.reorderFailed", { msg: String(e) }), 3200);
      return;
    }
    await refresh();
  }

  function renderList(): void {
    if (trees.length === 0) {
      sections.clear();
      renderCenter(t("topics.emptyTitle"), t("topics.emptyHint"));
      // A merge in progress can't continue with nothing to merge.
      if (merging) setMerging(false);
      return;
    }
    sections.clear();
    // 每个顶层标签渲成一行;有子标签的,紧跟一个 .topic-kids 子容器(缩进 + 左导轨),父行
    // 仍是 #list 的直接子(nextElementSibling = .topic-kids),子行收在容器内成一组。
    const built: HTMLElement[] = [];
    for (const g of groupByPrefix(trees)) {
      const parentSec = section(g.parent, g.parent.title, false, g.children.length);
      sections.set(g.parent.id, parentSec);
      built.push(parentSec);
      if (g.children.length) {
        const kids = el("div", { className: "topic-kids" });
        // 折叠态在重建时套回来(合并态强制展开:那时要选子标签,section 也不出折叠钮)。
        if (!merging && collapsedKids.has(g.parent.id)) kids.classList.add("collapsed");
        for (const c of g.children) {
          const childSec = section(c.topic, c.label, true);
          sections.set(c.topic.id, childSec);
          kids.append(childSec);
        }
        built.push(kids);
      }
    }
    list.replaceChildren(...built);
    paint();
  }

  // Show the right surface for the current mode/state. (No drill page anymore — tags
  // expand inline; merge mode reuses the same flat list with selection.)
  function render(): void {
    renderList();
  }

  // Toggle a tag in/out of the merge selection (a row click). The first one in
  // becomes the default survivor; reassign it via the merge-bar chips.
  function toggleSelect(id: string): void {
    if (selected.has(id)) deselect(id);
    else {
      selected.add(id);
      if (survivor === null) survivor = id; // first pick defaults to survivor
      confirming = false;
      paint();
    }
  }

  // Drop a tag from the selection (chip ×), moving the survivor crown if needed.
  function deselect(id: string): void {
    selected.delete(id);
    if (survivor === id) survivor = selected.values().next().value ?? null;
    confirming = false;
    paint();
  }

  // Crown a selected tag as the survivor (chip click): it keeps its identity,
  // the rest fold into it.
  function setSurvivor(id: string): void {
    if (!selected.has(id)) return;
    survivor = id;
    confirming = false;
    paint();
  }

  // Reflect selected/survivor state onto the live sections + the merge bar,
  // without rebuilding the list (keeps scroll and avoids re-animating cards).
  function paint(): void {
    for (const [id, sec] of sections) {
      sec.classList.toggle("selected", selected.has(id));
      sec.classList.toggle("survivor", merging && survivor === id);
    }
    paintBar();
  }

  function paintBar(): void {
    const n = selected.size;
    if (n >= 2 && survivor) {
      const keep = titles.get(survivor) ?? "";
      mbHint.replaceChildren(
        document.createTextNode(t("topics.mergeHintPre", { n })),
        el("b", { textContent: keep }),
        document.createTextNode(t("topics.mergeHintPost")),
      );
    } else if (n === 1) {
      mbHint.textContent = t("topics.mergeOne");
    } else {
      mbHint.textContent = t("topics.mergePrompt");
    }

    // One chip per selected tag; the survivor is highlighted and labelled 存续.
    mbChips.replaceChildren(
      ...[...selected].map((id) => {
        const isKeep = survivor === id;
        const label = el("span", {
          className: "mb-chip-label",
          textContent: titles.get(id) ?? t("topics.deleted"),
          title: t("topics.setKeep"),
        });
        label.addEventListener("click", () => setSurvivor(id));
        const x = el("span", { className: "mb-chip-x", textContent: "✕", title: t("topics.removeFromMerge") });
        x.addEventListener("click", () => deselect(id));
        const chip = el("div", { className: isKeep ? "mb-chip is-keep" : "mb-chip" });
        if (isKeep) chip.append(el("span", { className: "mb-chip-keep", textContent: t("topics.keep") }));
        chip.append(label, x);
        return chip;
      }),
    );

    // Rename box appears once a survivor is set; prime its value when survivor changes.
    const showRename = n >= 2 && !!survivor;
    mbRename.hidden = !showRename;
    if (showRename && renameFor !== survivor) {
      mbRename.value = titles.get(survivor!) ?? "";
      renameFor = survivor;
    }
    if (!showRename) renameFor = null;

    mbMerge.disabled = !(n >= 2 && survivor);
    mbMerge.textContent = confirming ? t("topics.mergeConfirm", { n }) : t("topics.merge");
  }

  function setMerging(on: boolean): void {
    merging = on;
    selected.clear();
    survivor = null;
    confirming = false;
    renameFor = null;
    // Merge needs the flat list; close the create form.
    if (on) {
      newform.hidden = true;
      newToggle.classList.remove("on");
    }
    view.classList.toggle("merging", on);
    mergeToggle.classList.toggle("on", on);
    // Only swap the label text — keep the kbd hint (.k) intact.
    (mergeToggle.querySelector(".lbl") as HTMLElement).textContent = on ? t("topics.done") : t("topics.mergeTags");
    mergebar.hidden = !on;
    render();
  }

  async function doMerge(): Promise<void> {
    if (selected.size < 2 || !survivor) return;
    if (!confirming) {
      confirming = true;
      paintBar();
      return;
    }
    const target = survivor;
    const sources = [...selected].filter((id) => id !== target);
    const renamed = mbRename.value.trim();
    // Send a rename only when it actually differs from the survivor's current title.
    const newTitle = renamed && renamed !== (titles.get(target) ?? "") ? renamed : null;
    try {
      await invoke("merge_topics", { sourceIds: sources, targetId: target, newTitle });
      setMerging(false);
      await refresh();
    } catch (err) {
      confirming = false;
      paintBar();
      // 操作失败走回执(合并栏还在,选择保留,用户可改后重试),不整页换错误页。
      toastAction(t("topics.mergeFailed", { msg: String(err) }), 3200);
    }
  }

  // refocus 指纹短路(ui-audit P1 #9c,与 inbox/board 同规):alt-tab 回焦、数据没变
  // 就不重绘——正在填的重命名表单/调色板/删除确认不再被无谓复位。
  let lastSig = "";
  // 删除确认的文档级监听:mount 级单值(codex P1 审 M3),重画/收场/unmount 统一收。
  let confirmOff: (() => void) | null = null;
  function disarmConfirm(): void {
    const f = confirmOff;
    confirmOff = null;
    if (f) f();
  }
  async function refresh(refocus = false): Promise<void> {
    try {
      const [t, tasks, cols] = await Promise.all([
        invoke<TopicTree[]>("list_topics_full"),
        invoke<TaskItem[]>("list_tasks"),
        // 列名(B-f 第 1 段):这里**要全部列、不过 boardColumns()** —— 下钻列表连已删列
        // 里的卡也要显示得出名字,而那道滤子是「看板画哪几列」的判据,不是命名的。
        loadBoardColumns(),
      ]);
      const sig = JSON.stringify([t, tasks, cols]);
      // `=== true` 同 inbox:防未来把 refresh 直接接成事件回调时 Event 误当 refocus。
      if (refocus === true && sig === lastSig) return;
      lastSig = sig;
      // ⛔ **只取任务列**:`columnName()` 对「没改过名却查不到 canonical」是响亮抛,而灵感那两
      // 列(`inbox`/`filed`)刻意没有显示名(灵感是纸面的默认态,不印列名)—— 整份 map 过去
      // 会在第一行就炸。⚠ 已删的任务列**要留着**:它里头的卡照样在这份下钻列表里。
      colName = new Map(
        (cols as BoardColumn[]).filter((c) => c.kind === "task").map((c) => [c.id, columnName(c)]),
      );
      trees = t;
      tasksByTopic = new Map();
      for (const task of tasks) {
        // Multi-tag: a task is listed under EACH of its tags.
        for (const tp of task.topics) {
          const arr = tasksByTopic.get(tp.id) ?? [];
          arr.push(task);
          tasksByTopic.set(tp.id, arr);
        }
      }
      // Drop any state referring to tags that no longer exist (keeps things tidy).
      const live = new Set(trees.map((x) => x.id));
      for (const id of [...expanded]) if (!live.has(id)) expanded.delete(id);
      for (const id of [...collapsedKids]) if (!live.has(id)) collapsedKids.delete(id);
      for (const id of [...selected]) if (!live.has(id)) selected.delete(id);
      if (survivor && !live.has(survivor)) survivor = selected.values().next().value ?? null;

      titles = new Map(trees.map((x) => [x.id, x.title]));
      disarmConfirm(); // 全量重画:在场确认的文档级监听一并收走(codex M3)
      render();
      // First render after a (re)mount: drop back to where the user was reading.
      // scrollTop clamps itself if the list is now shorter.
      if (restorePending) {
        restorePending = false;
        list.scrollTop = savedScroll;
      }
    } catch (err) {
      lastSig = ""; // 错误页已上画:下次 refocus 即使数据没变也要重画回正常列表
      disarmConfirm(); // 换错误页也是整批替换:在场确认的文档级监听一并收走(codex 二审 M)
      renderError(String(err));
    }
  }

  // ---- new-tag compose -----------------------------------------------------
  function setCreating(on: boolean): void {
    newform.hidden = !on;
    newToggle.classList.toggle("on", on);
    ntErr.textContent = "";
    if (on) {
      if (merging) setMerging(false); // create and merge are mutually exclusive
      ntTitle.focus();
    }
  }
  async function doCreate(): Promise<void> {
    if (!ntTitle.value.trim()) {
      ntErr.textContent = t("topics.nameRequired");
      return;
    }
    try {
      await invoke("create_topic", { title: ntTitle.value });
    } catch (e) {
      ntErr.textContent = String(e);
      return;
    }
    ntTitle.value = "";
    setCreating(false);
    await refresh();
  }

  // ---- wiring --------------------------------------------------------------
  newToggle.addEventListener("click", () => setCreating(newform.hidden));
  ntCreate.addEventListener("click", () => void doCreate());
  ntCancel.addEventListener("click", () => setCreating(false));
  ntTitle.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期不劫持(ui-audit P0 #1)
    if (e.key === "Enter") {
      e.preventDefault();
      void doCreate();
    } else if (e.key === "Escape") {
      setCreating(false);
    }
  });

  mergeToggle.addEventListener("click", () => setMerging(!merging));
  mbCancel.addEventListener("click", () => setMerging(false));
  mbMerge.addEventListener("click", () => void doMerge());
  mbRename.addEventListener("input", () => {
    // Typing into the rename box shouldn't keep a stale confirm armed.
    if (confirming) {
      confirming = false;
      paintBar();
    }
  });

  // 视图级全局单键(键义和列表里只读卡片无冲突):N 新建标签、M 合并标签。
  const teardownViewKeys = registerViewKeys([
    { key: "N", run: () => setCreating(newform.hidden) },
    { key: "M", run: () => setMerging(!merging) },
  ]);

  void refresh();

  return {
    unmount() {
      // Remember where the user was reading so the next mount can restore it.
      savedScroll = list.scrollTop;
      disarmConfirm(); // 在场确认的文档级监听不跨 mount 存活(codex M3)
      teardownViewKeys();
      root.replaceChildren();
    },
    onFocus() {
      void refresh(true);
    },
  };
}
