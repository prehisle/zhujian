// 两维筛选(标签 pills + 文本过滤词)的共享件 —— 任务看板(105)与灵感同一套
// 筛选行为(单一真相源,同 hotkey-menu.ts 的抽法):列表内容 = 标签过滤 ∩ 文本过滤,
// 两维正交。筛选状态由各视图自己以模块态持有(「跨视图切换保留」的语义属于视图,
// 见 board.ts topicFilter 的注释),本件只提供纯函数应用 + pills/输入框的 DOM 行为。
import "./filter-bar.css";

// A topic as the filter consumes it (pill label + optional dot color) — the shape
// list_topics returns and both views' items carry.
export type FilterTopic = { id: string; title: string; color: string | null };

// The two orthogonal dimensions. topic: "all" / "none" (无标签) / a topic id.
// text: 原始输入(匹配口径 trim + 忽略大小写,输入框回显保留原文)。
export type FilterState = { topic: string; text: string };

// 任一维激活即「筛选态」(看板拿它路由 visible-merge 拖拽)。
export function filterActive(f: FilterState): boolean {
  return f.topic !== "all" || f.text.trim() !== "";
}

// If the active filter points at a topic that no longer exists (deleted/merged),
// fall back to 所有 rather than showing a dead filter. Pure state fix (no DOM) —
// must run before the caller fingerprints the render.
export function reconcileTopicFilter(f: FilterState, allTopics: FilterTopic[]): void {
  if (f.topic !== "all" && f.topic !== "none" && !allTopics.some((t) => t.id === f.topic)) {
    f.topic = "all";
  }
}

// 应用两维过滤:先标签后文本。textOf 由视图给(看板=当前标题,灵感=当前正文——
// 连历史、跨回收站的找回忆是全局「搜索」视图的事,这里是干活时缩小视野)。
export function applyFilter<T extends { topics: { id: string }[] }>(
  items: T[],
  f: FilterState,
  textOf: (item: T) => string,
): T[] {
  const byTopic =
    f.topic === "all"
      ? items
      : f.topic === "none"
        ? items.filter((t) => t.topics.length === 0)
        : items.filter((t) => t.topics.some((tp) => tp.id === f.topic));
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
  const counts = new Map<string, number>();
  let none = 0;
  for (const t of items) {
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
  const pills = [pill("all", "所有", items.length), pill("none", "无标签", none)];
  for (const tp of allTopics) {
    const n = counts.get(tp.id) ?? 0;
    if (n === 0 && f.topic !== tp.id) continue;
    pills.push(pill(tp.id, tp.title, n, tp.color));
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
