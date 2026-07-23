// 两维筛选(标签 pills + 文本过滤词)的共享件 —— 任务看板(105)与灵感同一套
// 筛选行为(单一真相源,同 hotkey-menu.ts 的抽法):列表内容 = 标签过滤 ∩ 文本过滤,
// 两维正交。筛选状态由各视图自己以模块态持有(「跨视图切换保留」的语义属于视图,
// 见 board.ts topicFilter 的注释),本件只提供纯函数应用 + pills/输入框的 DOM 行为。
import "./filter-bar.css";

// A topic as the filter consumes it (pill label + optional dot color + optional kind).
// list_topics returns {id,title,color,kind}; per-card chips carry kind:null (only the
// board's allTopics 载真 kind——按类型筛选走它,见 renderKindPills)。
export type FilterTopic = { id: string; title: string; color: string | null; kind?: string | null };

// The three orthogonal dimensions. kind: "all" / a kind string(标签类型,如「人名」).
// topic: "all" / "none" (无标签) / a topic id. text: 原始输入(trim + 忽略大小写).
// 应用顺序 kind → topic → text;kind 是「钻取器」——选中一个类型先圈定「挂了该类型任一
// 标签的条目」,再把标签 pill 收到该类型内(见 renderFilterPills / renderKindPills)。
export type FilterState = { kind: string; topic: string; text: string };

// 任一维激活即「筛选态」(看板拿它路由 visible-merge 拖拽)。
export function filterActive(f: FilterState): boolean {
  return f.kind !== "all" || f.topic !== "all" || f.text.trim() !== "";
}

// The topic ids belonging to a given kind — the bridge from the kind axis (which lives
// on allTopics) to per-item topics (which carry only ids). 空 kind/无匹配 = 空集。
function idsOfKind(allTopics: FilterTopic[], kind: string): Set<string> {
  return new Set(allTopics.filter((t) => t.kind === kind).map((t) => t.id));
}

// If the active filter points at a topic that no longer exists (deleted/merged),
// fall back to 所有 rather than showing a dead filter. Pure state fix (no DOM) —
// must run before the caller fingerprints the render.
export function reconcileTopicFilter(f: FilterState, allTopics: FilterTopic[]): void {
  if (f.topic !== "all" && f.topic !== "none" && !allTopics.some((t) => t.id === f.topic)) {
    f.topic = "all";
  }
}

// 类型轴同样的死筛修复:选中的 kind 已无任何标签(标签被删/改类型)→ 回落 全部类型;
// 且若 kind 仍在但当前具体标签不属该 kind(切了类型)→ 标签轴回落 所有。Pure state fix,
// 与 reconcileTopicFilter 一样必须在渲染指纹之前跑。
export function reconcileKindFilter(f: FilterState, allTopics: FilterTopic[]): void {
  if (f.kind === "all") return;
  const ids = idsOfKind(allTopics, f.kind);
  if (ids.size === 0) {
    f.kind = "all";
    return;
  }
  if (f.topic !== "all" && f.topic !== "none" && !ids.has(f.topic)) f.topic = "all";
}

// 应用三维过滤:先类型(圈定挂该类型标签的条目)、再标签、后文本。textOf 由视图给
// (看板=当前标题,灵感=当前正文——连历史、跨回收站的找回忆是全局「搜索」视图的事,
// 这里是干活时缩小视野)。allTopics 只在 kind 激活时用于把类型解析成标签 id 集(灵感
// 恒 kind="all",故不传也无妨)。
export function applyFilter<T extends { topics: { id: string }[] }>(
  items: T[],
  f: FilterState,
  textOf: (item: T) => string,
  allTopics: FilterTopic[] = [],
): T[] {
  const byKind =
    f.kind === "all"
      ? items
      : ((kindIds) => items.filter((t) => t.topics.some((tp) => kindIds.has(tp.id))))(
          idsOfKind(allTopics, f.kind),
        );
  const byTopic =
    f.topic === "all"
      ? byKind
      : f.topic === "none"
        ? byKind.filter((t) => t.topics.length === 0)
        : byKind.filter((t) => t.topics.some((tp) => tp.id === f.topic));
  const q = f.text.trim().toLowerCase();
  return q === "" ? byTopic : byTopic.filter((t) => textOf(t).toLowerCase().includes(q));
}

// The pills: 所有 / 无标签 / each topic present on an item. Counts come from `items`
// (a multi-tagged item counts under each of its tags) and 刻意保持全量口径(不随文本
// 过滤收缩):两个过滤维度正交,文本过滤只收窄列表,不改「各标签下有多少」这句话的
// 意思。A topic with zero items is hidden unless it is the current filter (so the
// selection never vanishes from under the user).
export function renderFilterPills(
  bar: HTMLElement,
  items: { topics: FilterTopic[] }[],
  allTopics: FilterTopic[],
  f: FilterState,
  onChange: () => void,
): void {
  // kind 激活时,标签 pill 收到该类型内:取值域 = 该 kind 的标签、条目先按 kind 圈定
  // (「所有」= 该类型全部)、不画「无标签」pill(无标签条目不属任何类型)。
  const kindActive = f.kind !== "all";
  const kindIds = kindActive ? idsOfKind(allTopics, f.kind) : null;
  const scoped = kindIds ? items.filter((t) => t.topics.some((tp) => kindIds.has(tp.id))) : items;
  const domain = kindIds ? allTopics.filter((t) => kindIds.has(t.id)) : allTopics;

  const counts = new Map<string, number>();
  let none = 0;
  for (const t of scoped) {
    if (t.topics.length === 0) none += 1;
    else for (const tp of t.topics) counts.set(tp.id, (counts.get(tp.id) ?? 0) + 1);
  }
  const pill = (key: string, label: string, n: number, color?: string | null) => {
    const b = document.createElement("button");
    b.className = `tf-pill${f.topic === key ? " active" : ""}`;
    // 有色标签的筛选钮带一颗色点(所有 / 无标签 无色点),让整条筛选条也读出颜色分布。
    if (color) {
      const d = document.createElement("span");
      d.className = "tf-dot";
      d.style.setProperty("--tag-color", color);
      b.append(d);
    }
    const nEl = document.createElement("span");
    nEl.className = "tf-n";
    nEl.textContent = String(n);
    b.append(document.createTextNode(label), nEl);
    b.onclick = () => {
      f.topic = key;
      onChange();
    };
    return b;
  };
  const pills = kindActive
    ? [pill("all", "所有", scoped.length)]
    : [pill("all", "所有", items.length), pill("none", "无标签", none)];
  for (const tp of domain) {
    const n = counts.get(tp.id) ?? 0;
    if (n === 0 && f.topic !== tp.id) continue;
    const p = pill(tp.id, tp.title, n, tp.color);
    // 真标签 pill 挂 topic id(所有/无标签不挂):看板据此把 pill 接成拖拽打标签的拖源/落点
    // (纯元数据,灵感侧不接线故无副作用)。
    p.dataset.topicId = tp.id;
    pills.push(p);
  }
  bar.replaceChildren(...pills);
}

// 类型轴 pill 行(0031 kind):全部类型 + 库里出现过的每个 kind。仅当至少一个标签标了
// kind 才有内容(否则清空 bar,CSS `:empty` 隐藏整行——无 kind 就一条不多)。计数口径
// 同标签 pill:挂该类型任一标签的条目数(全量,不随文本收缩)。选一个 kind 会把标签轴
// 回落 所有(重新圈定,躲死筛)。只看板接线,灵感不调故无 kind 行。
export function renderKindPills(
  bar: HTMLElement,
  items: { topics: FilterTopic[] }[],
  allTopics: FilterTopic[],
  f: FilterState,
  onChange: () => void,
): void {
  // distinct kinds,按 allTopics 顺序(= 标签手调 position 序)首次出现排列。
  const kinds: string[] = [];
  for (const t of allTopics) {
    if (t.kind && !kinds.includes(t.kind)) kinds.push(t.kind);
  }
  if (kinds.length === 0) {
    bar.replaceChildren();
    return;
  }
  const pill = (key: string, label: string, n?: number) => {
    const b = document.createElement("button");
    b.className = `tf-pill kind-pill${f.kind === key ? " active" : ""}`;
    b.append(document.createTextNode(label));
    if (n !== undefined) {
      const nEl = document.createElement("span");
      nEl.className = "tf-n";
      nEl.textContent = String(n);
      b.append(nEl);
    }
    b.onclick = () => {
      f.kind = key;
      f.topic = "all"; // 切类型 = 重新圈定,标签轴归零(reconcileKindFilter 亦保此)
      onChange();
    };
    return b;
  };
  const label = document.createElement("span");
  label.className = "tf-axis";
  label.textContent = "类型";
  const pills: (HTMLElement | Text)[] = [label, pill("all", "全部类型")];
  for (const k of kinds) {
    const ids = idsOfKind(allTopics, k);
    const n = items.filter((t) => t.topics.some((tp) => ids.has(tp.id))).length;
    pills.push(pill(k, k, n));
  }
  bar.replaceChildren(...pills);
}

// 文本过滤框接线(mount 时调一次):输入即筛,走视图的单一渲染路径;Esc 清词(已空
// 则 blur)。输入框必须是 filter-row 的常驻元素、不在 pills 的 replaceChildren 重建
// 范围里,打字过程中的重渲才不丢焦点;单键(视图键、卡片键)对输入框焦点自动让位
// (hotkey-menu 的两处 tagName 检查)。
export function wireFilterInput(
  input: HTMLInputElement,
  f: FilterState,
  onChange: () => void,
): void {
  input.value = f.text; // 切视图回来恢复(模块态值)
  input.addEventListener("input", () => {
    f.text = input.value;
    onChange();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (input.value === "") {
      input.blur();
      return;
    }
    input.value = "";
    f.text = "";
    onChange();
  });
}
