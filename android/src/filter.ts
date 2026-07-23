// 时间轴筛选(灵感 / 看板两面):标签 pills + 文本过滤 + 标签类型(kind)三维正交,
// 与桌面共享件 src/filter-bar.ts 同一套语义——安卓是独立前端工程、不能跨工程 import,
// 故此处复制**纯逻辑**(应用顺序、口径、钻取语义严格一致),只把渲染换成触屏形态
// (pill 行横向滑动、点即筛)。三维应用顺序 kind → topic → text:选一个类型先圈定
// 「挂了该类型任一标签的条目」,再把标签 pill 收到该类型内,可再钻到具体某枚;切类型
// 即把标签轴归零。per-item 的 topics 只带 id/title/color(不带 kind),类型真相只在
// allTopics(来自 list_topics_full)。

export type FilterTopic = { id: string; title: string; color: string | null; kind: string | null };
// kind: "all" / 某个类型字符串;topic: "all" / "none"(无标签)/ 某标签 id;text: 原始输入。
export type FilterState = { kind: string; topic: string; text: string };

// 任一维激活即「筛选态」(供空态文案区分「本面没条目」与「筛空」)。
export function filterActive(f: FilterState): boolean {
  return f.kind !== "all" || f.topic !== "all" || f.text.trim() !== "";
}

// 某类型名下的标签 id 集——从 kind 轴(只在 allTopics 上)桥到 per-item 的标签 id。
function idsOfKind(all: FilterTopic[], kind: string): Set<string> {
  return new Set(all.filter((t) => t.kind === kind).map((t) => t.id));
}

// 死标签回落:选中的标签已被删/合并 → 回「所有」(纯状态,须先于渲染 pills)。
export function reconcileTopicFilter(f: FilterState, all: FilterTopic[]): void {
  if (f.topic !== "all" && f.topic !== "none" && !all.some((t) => t.id === f.topic)) f.topic = "all";
}

// 死类型回落 + 切类型后标签轴归一:选中的 kind 已无任何标签 → 回「全部类型」;kind 仍在
// 但当前具体标签不属该 kind → 标签轴回「所有」(纯状态,先于渲染 pills)。
export function reconcileKindFilter(f: FilterState, all: FilterTopic[]): void {
  if (f.kind === "all") return;
  const ids = idsOfKind(all, f.kind);
  if (ids.size === 0) {
    f.kind = "all";
    return;
  }
  if (f.topic !== "all" && f.topic !== "none" && !ids.has(f.topic)) f.topic = "all";
}

// 三维应用:先类型(圈定挂该类型标签的条目)、再标签、后文本。textOf 由调用方给
// (灵感/任务都用 content);allTopics 只在 kind 激活时用于把类型解析成标签 id 集。
export function applyFilter<T extends { topics: { id: string }[] }>(
  items: T[],
  f: FilterState,
  textOf: (i: T) => string,
  all: FilterTopic[],
): T[] {
  const byKind =
    f.kind === "all"
      ? items
      : ((ids) => items.filter((t) => t.topics.some((tp) => ids.has(tp.id))))(idsOfKind(all, f.kind));
  const byTopic =
    f.topic === "all"
      ? byKind
      : f.topic === "none"
        ? byKind.filter((t) => t.topics.length === 0)
        : byKind.filter((t) => t.topics.some((tp) => tp.id === f.topic));
  const q = f.text.trim().toLowerCase();
  return q === "" ? byTopic : byTopic.filter((t) => textOf(t).toLowerCase().includes(q));
}

// 点 pill 的回执:主视图据 patch 先过草稿闸再改状态、重投影(不在此直接改 f,免绕过闸)。
type OnPick = (patch: Partial<FilterState>) => void;
// per-item 的标签只需 id 参与计数/圈定(标题/颜色/kind 的真相都在 allTopics)。
type ChipItem = { topics: { id: string }[] };

function pill(label: string, active: boolean, onClick: () => void, count?: number, color?: string | null): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `fpill${active ? " active" : ""}`;
  b.type = "button";
  if (color) {
    const d = document.createElement("span");
    d.className = "fdot";
    d.style.setProperty("--tc", color);
    b.append(d);
  }
  b.append(document.createTextNode(label));
  if (count !== undefined) {
    const n = document.createElement("span");
    n.className = "fn";
    n.textContent = String(count);
    b.append(n);
  }
  b.addEventListener("click", onClick);
  return b;
}

// 类型轴 pill 行(0031 kind):全部类型 + 库里出现过的每个 kind(按 allTopics 的手调
// position 序首现排列)。仅当至少一个标签标了 kind 才有内容——否则清空 bar,CSS
// `:empty` 隐整行(无 kind 一条不多)。计数=挂该类型任一标签的条目数(全量,不随
// 文本收缩)。选一个 kind 会把标签轴回落「所有」(重新圈定,躲死筛)。
export function renderKindPills(
  bar: HTMLElement,
  items: ChipItem[],
  all: FilterTopic[],
  f: FilterState,
  onPick: OnPick,
): void {
  const kinds: string[] = [];
  for (const t of all) if (t.kind && !kinds.includes(t.kind)) kinds.push(t.kind);
  if (kinds.length === 0) {
    bar.replaceChildren();
    return;
  }
  const nodes: (HTMLElement | Text)[] = [];
  const axis = document.createElement("span");
  axis.className = "faxis";
  axis.textContent = "类型";
  nodes.push(axis);
  nodes.push(pill("全部类型", f.kind === "all", () => onPick({ kind: "all", topic: "all" })));
  for (const k of kinds) {
    const ids = idsOfKind(all, k);
    const n = items.filter((t) => t.topics.some((tp) => ids.has(tp.id))).length;
    nodes.push(pill(k, f.kind === k, () => onPick({ kind: k, topic: "all" }), n));
  }
  bar.replaceChildren(...nodes);
}

// 标签轴 pill 行:所有 / 无标签 / 每个当前出现的标签。计数从 items 派生(多标签条目
// 在每个标签下各计一次)、刻意保持全量口径(不随文本收缩,两维正交)。零计数标签隐藏,
// 除非它正被选中(选择永不从脚下消失)。kind 激活时收到该类型内:取值域=该 kind 的
// 标签、条目先按 kind 圈定、不画「无标签」pill(无标签条目不属任何类型)。
export function renderTopicPills(
  bar: HTMLElement,
  items: ChipItem[],
  all: FilterTopic[],
  f: FilterState,
  onPick: OnPick,
): void {
  const kindActive = f.kind !== "all";
  const kindIds = kindActive ? idsOfKind(all, f.kind) : null;
  const scoped = kindIds ? items.filter((t) => t.topics.some((tp) => kindIds.has(tp.id))) : items;
  const domain = kindIds ? all.filter((t) => kindIds.has(t.id)) : all;

  const counts = new Map<string, number>();
  let none = 0;
  for (const t of scoped) {
    if (t.topics.length === 0) none += 1;
    else for (const tp of t.topics) counts.set(tp.id, (counts.get(tp.id) ?? 0) + 1);
  }
  const nodes: HTMLElement[] = [];
  nodes.push(
    pill("所有", f.topic === "all", () => onPick({ topic: "all" }), kindActive ? scoped.length : items.length),
  );
  if (!kindActive) nodes.push(pill("无标签", f.topic === "none", () => onPick({ topic: "none" }), none));
  for (const tp of domain) {
    const n = counts.get(tp.id) ?? 0;
    if (n === 0 && f.topic !== tp.id) continue;
    nodes.push(pill(tp.title, f.topic === tp.id, () => onPick({ topic: tp.id }), n, tp.color));
  }
  bar.replaceChildren(...nodes);
}
