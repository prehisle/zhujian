import { invoke } from "./space";
import type { View, ViewCtx } from "./notebook";
import { type TaskItem, PRIORITY_LABEL, dueLabel, dueState, localToday } from "./tasktime";
import { copyButton } from "./clipboard";
import { armDismiss, registerViewKeys } from "./hotkey-menu";
import { TAG_COLORS } from "./tag-color";
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
  notes: TopicNote[];
};

// 任务状态 -> 看板列中文名(mirror board.ts COLUMNS),下钻态只读展示用。
const COL_NAME: Record<string, string> = {
  todo: "待办",
  doing: "进行中",
  confirming: "待确认",
  done: "已完成",
};

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

// RFC3339 UTC -> a short local stamp, e.g. "6月13日 14:23".
const fmt = new Intl.DateTimeFormat("zh-CN", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
function when(iso: string): string {
  return fmt.format(new Date(iso));
}

// ---- 前缀分组(纯视觉层级)---------------------------------------------------
// 标签名带 `/` 时(如 zhujian/同步),若存在与首段同名的父标签,该行缩进到父标签下、
// 只显后缀。语义仍是平的:分组只影响列表排版,筛选/计数/重命名/合并/删除全不感知层级
// (看板筛父标签不含子;一条内容两边都该算就打两个标签——M:N 本来就支持)。只按第一段
// 分一层视觉层级,多级斜杠不再细分;没有同名父标签的 a/b 保持平铺显全名(不造假组头)。
type TopicRow = { topic: TopicTree; label: string; child: boolean };
function groupByPrefix(trees: TopicTree[]): TopicRow[] {
  const titles = new Set(trees.map((t) => t.title));
  const children = new Map<string, TopicTree[]>();
  const tops: TopicTree[] = [];
  for (const t of trees) {
    const i = t.title.indexOf("/");
    // 首尾斜杠("/x"、"x/")不算前缀写法,照平铺走。
    const prefix = i > 0 && i < t.title.length - 1 ? t.title.slice(0, i) : null;
    if (prefix !== null && titles.has(prefix)) {
      const arr = children.get(prefix);
      if (arr) arr.push(t);
      else children.set(prefix, [t]);
    } else {
      tops.push(t);
    }
  }
  const rows: TopicRow[] = [];
  for (const t of tops) {
    rows.push({ topic: t, label: t.title, child: false });
    // 子标签保持后端给的相对顺序(最近变动在前,同顶层列表一个排序原则)。
    for (const c of children.get(t.title) ?? [])
      rows.push({ topic: c, label: c.title.slice(t.title.length + 1), child: true });
  }
  return rows;
}

// Which tags are expanded (collapse/expand state). Module scope so leaving the view
// and coming back keeps the same rows open — a UI preference, not data.
const expanded = new Set<string>();

// List scroll offset, captured on unmount and restored on the next mount so a view
// switch returns you to where you were reading (same rationale as inbox.ts savedScroll).
let savedScroll = 0;

const SKELETON = `
  <header data-tauri-drag-region>
    <h1>标签</h1>
    <button id="new-toggle" class="hbtn" type="button">新建标签 <kbd class="k">N</kbd></button>
    <button id="merge-toggle" class="hbtn" type="button"><span class="lbl">合并标签</span> <kbd class="k">M</kbd></button>
  </header>
  <div id="newform" class="newform" hidden>
    <input id="nt-title" class="nt-title" type="text" placeholder="标签名…" />
    <button id="nt-create" class="mb-btn go" type="button">创建</button>
    <button id="nt-cancel" class="mb-btn" type="button">取消</button>
    <span id="nt-err" class="nt-err"></span>
  </div>
  <main id="list"></main>
  <footer id="mergebar" class="mergebar" hidden>
    <span id="mb-hint" class="mb-hint"></span>
    <div id="mb-chips" class="mb-chips"></div>
    <input id="mb-rename" class="mb-rename" type="text" placeholder="合并后标题(可改)" hidden />
    <button id="mb-merge" class="mb-btn go" type="button" disabled>合并</button>
    <button id="mb-cancel" class="mb-btn" type="button">取消</button>
  </footer>
`;

export function mount(root: HTMLElement, _ctx: ViewCtx): View {
  const view = el("div", { className: "v-topics" });
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

  function renderError(message: string): void {
    list.replaceChildren(
      el("div", { className: "center" }, [
        el("div", { className: "big", textContent: "读取失败" }),
        el("div", { className: "err-box", textContent: message }),
      ]),
    );
  }

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
  // `label` 是列表里显示的名字(子标签只显后缀),`child` 只加缩进——重命名/合并/chips
  // 等一切别处仍用全名 topic.title。
  function section(topic: TopicTree, label: string, child: boolean): HTMLElement {
    const sec = el("section", { className: child ? "topic child" : "topic" });
    const tasks = tasksByTopic.get(topic.id) ?? [];

    const check = el("span", { className: "check", textContent: "" }); // ✓ (merge mode)
    const caret = el("span", { className: "topic-caret", textContent: "▸" });
    // 色点:有色标签才现身(反映当前颜色,和看板 chip 一致);无色不占位。
    const dot = el("span", { className: "topic-dot" });
    if (topic.color) {
      dot.style.setProperty("--tag-color", topic.color);
      dot.classList.add("on");
    }
    const titleEl = el("span", { className: "topic-title", textContent: label });
    if (child) titleEl.title = topic.title; // 悬停可见全名(后缀脱离上下文时的兜底)
    const head = el("div", { className: "topic-head" }, [
      check,
      caret,
      dot,
      titleEl,
      el("span", {
        className: "topic-count",
        textContent: `${topic.notes.length} 条灵感 · ${tasks.length} 个任务`,
      }),
      el("span", { className: "keep-badge", textContent: "存续" }),
    ]);

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
    const showActions = () =>
      actions.replaceChildren(tbtn("颜色", openColor), tbtn("重命名", openEdit), tbtn("删除", confirmDelete, true));

    // 颜色:调色板行(一排色块 + 无色),就地替换动作区(同「删除?」的 in-place swap)。
    // 点色块即写入并刷新——手选热标签,默认无色。
    async function setColor(hex: string | null): Promise<void> {
      try {
        await invoke("set_topic_color", { id: topic.id, color: hex });
      } catch (e) {
        renderError(String(e));
        return;
      }
      await refresh();
    }
    function openColor(): void {
      const swatch = (hex: string | null): HTMLElement => {
        const b = el("button", {
          className: hex ? "color-swatch" : "color-swatch none",
          title: hex ?? "无色",
          textContent: hex ? "" : "无",
        });
        if (hex) b.style.setProperty("--tag-color", hex);
        if ((topic.color ?? null) === hex) b.classList.add("current");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          void setColor(hex);
        });
        return b;
      };
      actions.replaceChildren(
        el("div", { className: "color-row" }, [...TAG_COLORS.map((c) => swatch(c.hex)), swatch(null)]),
        tbtn("完成", showActions),
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
      actions.replaceChildren(
        el("span", { className: "td-q", textContent: "删除标签?" }),
        tbtn("取消", () => {
          disarmConfirm();
          showActions();
        }),
        tbtn("删除", () => {
          disarmConfirm();
          void doDelete();
        }, true),
      );
    }
    async function doDelete(): Promise<void> {
      try {
        await invoke("delete_topic", { id: topic.id });
      } catch (e) {
        renderError(String(e));
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
          el("span", { className: "te-label", textContent: "重命名标签" }),
          titleInput,
          el("div", { className: "te-actions" }, [
            el("button", { className: "mb-btn", textContent: "取消", onclick: () => void refresh() }),
            el("button", { className: "mb-btn go", textContent: "保存", onclick: () => void save() }),
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
  function taskRow(t: TaskItem, today: string): HTMLElement {
    const meta: Node[] = [el("span", { className: "dtask-col", textContent: COL_NAME[t.status] ?? t.status })];
    if (t.due_on) {
      const st = dueState(t.due_on, today);
      meta.push(el("span", { className: `dtask-due ${st}`, textContent: dueLabel(t.due_on, today) }));
    }
    if (t.priority) {
      meta.push(el("span", { className: `dtask-pri p${t.priority}`, textContent: `优先级·${PRIORITY_LABEL[t.priority]}` }));
    }
    const card = el("article", { className: "dtask" }, [
      el("p", { className: "dtask-title", textContent: t.title }),
      el("div", { className: "dtask-meta" }, meta),
    ]);
    card.append(copyButton(t.title, "dtask-copy"));
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
      : [el("div", { className: "drill-empty", textContent: "还没有灵感打这个标签" })];
    const notesSec = el("section", { className: "drill-sec" }, [
      el("h2", { className: "drill-h", textContent: `灵感 ${topic.notes.length}` }),
      el("div", { className: "drill-notes" }, noteCards),
    ]);
    const taskCards = tasks.length
      ? tasks.map((t) => taskRow(t, today))
      : [el("div", { className: "drill-empty", textContent: "还没有任务打这个标签" })];
    const tasksSec = el("section", { className: "drill-sec" }, [
      el("h2", { className: "drill-h", textContent: `任务 ${tasks.length}` }),
      el("div", { className: "drill-tasks" }, taskCards),
    ]);
    return el("div", { className: "topic-body" }, [notesSec, tasksSec]);
  }

  function renderList(): void {
    if (trees.length === 0) {
      sections.clear();
      renderCenter("还没有标签", "点右上角「新建标签」创建一个,或在「灵感」里给条目打标签。");
      // A merge in progress can't continue with nothing to merge.
      if (merging) setMerging(false);
      return;
    }
    sections.clear();
    const built = groupByPrefix(trees).map((r) => {
      const sec = section(r.topic, r.label, r.child);
      sections.set(r.topic.id, sec);
      return sec;
    });
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
        document.createTextNode(`把 ${n} 个标签合并到 「`),
        el("b", { textContent: keep }),
        document.createTextNode("」(点下面的标签可改存续目标)"),
      );
    } else if (n === 1) {
      mbHint.textContent = "已选 1 个 · 再选至少一个才能合并";
    } else {
      mbHint.textContent = "选择 2 个以上标签,合并成一个";
    }

    // One chip per selected tag; the survivor is highlighted and labelled 存续.
    mbChips.replaceChildren(
      ...[...selected].map((id) => {
        const isKeep = survivor === id;
        const label = el("span", {
          className: "mb-chip-label",
          textContent: titles.get(id) ?? "(已删除)",
          title: "设为存续标签",
        });
        label.addEventListener("click", () => setSurvivor(id));
        const x = el("span", { className: "mb-chip-x", textContent: "✕", title: "移出合并" });
        x.addEventListener("click", () => deselect(id));
        const chip = el("div", { className: isKeep ? "mb-chip is-keep" : "mb-chip" });
        if (isKeep) chip.append(el("span", { className: "mb-chip-keep", textContent: "存续" }));
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
    mbMerge.textContent = confirming ? `确认合并 ${n} 个?` : "合并";
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
    (mergeToggle.querySelector(".lbl") as HTMLElement).textContent = on ? "完成" : "合并标签";
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
      disarmConfirm(); // 换错误页 = 整批替换,在场确认监听一并收走(codex 二审 M)
      renderError(String(err));
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
      const [t, tasks] = await Promise.all([
        invoke<TopicTree[]>("list_topics_full"),
        invoke<TaskItem[]>("list_tasks"),
      ]);
      const sig = JSON.stringify([t, tasks]);
      // `=== true` 同 inbox:防未来把 refresh 直接接成事件回调时 Event 误当 refocus。
      if (refocus === true && sig === lastSig) return;
      lastSig = sig;
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
      ntErr.textContent = "标签名不能为空";
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
