// 时间轴筛选(灵感 / 看板两面):标签 pills + 文本过滤 + 标签类型(kind)三维正交,
// 与桌面共享件 src/filter-bar.ts 同一套语义——安卓是独立前端工程、不能跨工程 import,
// 故此处复制**纯逻辑**(应用顺序、口径、钻取语义、多选并集、父子折叠严格一致),只把
// 渲染换成触屏形态(pill 行横向滑动、点即筛、折叠箭头按手指尺寸放大)。三维应用顺序
// kind → topics → text:选一个类型先圈定「挂了该类型任一标签的条目」,再把标签 pill 收到
// 该类型内,可再钻到具体某枚;切类型即把标签轴归零。per-item 的 topics 只带 id/title/color
// (不带 kind),类型真相只在 allTopics(来自 list_topics_full)。

export type FilterTopic = { id: string; title: string; color: string | null; kind: string | null };
// kind: "all" / 某个类型字符串;topics: 被选中的标签集,**OR/并集语义**——空数组 =
// 「所有」(不按标签筛);元素为 "none"(无标签)或某标签 id;同时选中多个 = 显示挂了
// 其中任一标签的条目。text: 原始输入。
export type FilterState = { kind: string; topics: string[]; text: string };

// 任一维激活即「筛选态」(供空态文案区分「本面没条目」与「筛空」)。
export function filterActive(f: FilterState): boolean {
  return f.kind !== "all" || f.topics.length > 0 || f.text.trim() !== "";
}

// 当前是否恰好只筛了「单一具体标签」(非无标签)——返回它的 id,否则 null。用于「卡片
// 隐藏那枚重复 chip」(同桌面 218 / filter-bar.ts):单选时筛出来的卡本就都带它,同名
// chip 是纯冗余;多选 OR 下每枚 chip 表明「凭哪个标签入选」是有效信息、不该藏。
export function soleTopicFilter(f: FilterState): string | null {
  return f.topics.length === 1 && f.topics[0] !== "none" ? f.topics[0] : null;
}

// 被筛具体标签的中文名列表(供筛空空态提示「「A、B」下没有…」)。none 显「无标签」,
// id 解析成标签名(找不到 = 已删,显「该标签」占位)。空数组 = 未筛具体标签。
export function selectedTopicLabels(f: FilterState, all: FilterTopic[]): string[] {
  return f.topics.map((tok) =>
    tok === "none" ? "无标签" : (all.find((t) => t.id === tok)?.title ?? "该标签"),
  );
}

// 某类型名下的标签 id 集——从 kind 轴(只在 allTopics 上)桥到 per-item 的标签 id。
function idsOfKind(all: FilterTopic[], kind: string): Set<string> {
  return new Set(all.filter((t) => t.kind === kind).map((t) => t.id));
}

// 死标签回落:选中的标签已被删/合并 → 从选集里剔掉(纯状态,须先于渲染 pills)。
export function reconcileTopicFilter(f: FilterState, all: FilterTopic[]): void {
  f.topics = f.topics.filter((tok) => tok === "none" || all.some((t) => t.id === tok));
}

// 死类型回落 + 切类型后标签轴归一:选中的 kind 已无任何标签 → 回「全部类型」;kind 仍在
// 则选集只留属于该 kind 的具体标签(none 不属任何类型、类型态也不画无标签 pill)。
// 纯状态,先于渲染 pills。
export function reconcileKindFilter(f: FilterState, all: FilterTopic[]): void {
  if (f.kind === "all") return;
  const ids = idsOfKind(all, f.kind);
  if (ids.size === 0) {
    f.kind = "all";
    return;
  }
  f.topics = f.topics.filter((tok) => tok !== "none" && ids.has(tok));
}

// 三维应用:先类型(圈定挂该类型标签的条目)、再标签(并集)、后文本。textOf 由调用方给
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
  // OR/并集:选集空 = 全部;否则条目命中选集里任一 token(none = 无标签,id = 挂该标签)。
  const byTopic =
    f.topics.length === 0
      ? byKind
      : byKind.filter((t) =>
          f.topics.some((tok) =>
            tok === "none" ? t.topics.length === 0 : t.topics.some((tp) => tp.id === tok),
          ),
        );
  const q = f.text.trim().toLowerCase();
  return q === "" ? byTopic : byTopic.filter((t) => textOf(t).toLowerCase().includes(q));
}

// 点 pill 的回执:主视图据 patch 先过草稿闸再改状态、重投影(不在此直接改 f,免绕过闸)。
type OnPick = (patch: Partial<FilterState>) => void;
// per-item 的标签只需 id 参与计数/圈定(标题/颜色/kind 的真相都在 allTopics)。
type ChipItem = { topics: { id: string }[] };

// 筛选条里「已展开子标签」的父标签集(同桌面 filter-bar.ts)。默认收起(不在集里 = 子标签
// pill 藏起来),点父 pill 上的箭头翻。模块级——跨重投影存活,灵感与任务两面共享一份
// (标签层级两面相同,展开态一致即可);切空间不清,旧空间的标签 id 永不误命中(ULID)。
const expandedParents = new Set<string>();

// 把 domain 标签按 `父/子` 前缀分组(与标签视图 topics.ts 同规:仅当存在同名父标签才算子;
// 首尾斜杠不算)。返回顶层序(保 domain 原序)+ 每个顶层的子标签(后缀标签)。只按第一段
// 分一层,多级斜杠不再细分;没有同名父的照平铺。
function groupPills(
  domain: FilterTopic[],
): { parent: FilterTopic; kids: { topic: FilterTopic; label: string }[] }[] {
  const titles = new Set(domain.map((t) => t.title));
  const kidsOf = new Map<string, FilterTopic[]>();
  const tops: FilterTopic[] = [];
  for (const t of domain) {
    const i = t.title.indexOf("/");
    const prefix = i > 0 && i < t.title.length - 1 ? t.title.slice(0, i) : null;
    if (prefix !== null && titles.has(prefix)) {
      const arr = kidsOf.get(prefix);
      if (arr) arr.push(t);
      else kidsOf.set(prefix, [t]);
    } else tops.push(t);
  }
  return tops.map((t) => ({
    parent: t,
    kids: (kidsOf.get(t.title) ?? []).map((c) => ({ topic: c, label: c.title.slice(t.title.length + 1) })),
  }));
}

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
// 文本收缩)。选一个 kind 会把标签轴归零(重新圈定,躲死筛)。
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
  nodes.push(pill("全部类型", f.kind === "all", () => onPick({ kind: "all", topics: [] })));
  for (const k of kinds) {
    const ids = idsOfKind(all, k);
    const n = items.filter((t) => t.topics.some((tp) => ids.has(tp.id))).length;
    nodes.push(pill(k, f.kind === k, () => onPick({ kind: k, topics: [] }), n));
  }
  bar.replaceChildren(...nodes);
}

// 标签轴 pill 行:所有 / 无标签 / 每个当前出现的标签,**多选并集**。计数从 items 派生
// (多标签条目在每个标签下各计一次)、刻意保持全量口径(不随文本收缩,两维正交)。零计数
// 标签隐藏,除非它正被选中(选择永不从脚下消失)。kind 激活时收到该类型内:取值域=该 kind
// 的标签、条目先按 kind 圈定、不画「无标签」pill(无标签条目不属任何类型)、且不做前缀分组
// (保持扁平,drill 语义单纯)。
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

  // 点某枚标签 pill 后的新选集。「所有」= 清空。「无标签」与具体标签**互斥**:一个条目不
  // 可能既无标签又挂着某标签,把两者 OR 到一起是无意义的并集——故选「无标签」清掉所有标签、
  // 选某标签清掉「无标签」。具体标签之间才是多选 OR(切进/切出)。
  const toggled = (key: string): string[] => {
    if (key === "none") return f.topics.includes("none") ? [] : ["none"];
    const rest = f.topics.filter((t) => t !== "none");
    const i = rest.indexOf(key);
    if (i >= 0) rest.splice(i, 1);
    else rest.push(key);
    return rest;
  };

  const nodes: HTMLElement[] = [];
  nodes.push(
    pill("所有", f.topics.length === 0, () => onPick({ topics: [] }), kindActive ? scoped.length : items.length),
  );
  if (!kindActive) {
    nodes.push(pill("无标签", f.topics.includes("none"), () => onPick({ topics: toggled("none") }), none));
  }

  // 一个标签是否该出现:有条目 或 正被选中(选中的绝不因 0 计数消失)。
  const visible = (tp: FilterTopic) => (counts.get(tp.id) ?? 0) > 0 || f.topics.includes(tp.id);
  // 造一枚真标签 pill 并入列。child=true 的挂 .child + data-parent(供折叠显隐 + 皮肤)。
  const pushTopic = (tp: FilterTopic, label: string, child: boolean, parentId?: string): HTMLElement => {
    const p = pill(label, f.topics.includes(tp.id), () => onPick({ topics: toggled(tp.id) }), counts.get(tp.id) ?? 0, tp.color);
    p.dataset.topicId = tp.id;
    if (child) {
      p.classList.add("child");
      if (parentId) p.dataset.parent = parentId;
    }
    nodes.push(p);
    return p;
  };

  if (kindActive) {
    for (const tp of domain) if (visible(tp)) pushTopic(tp, tp.title, false);
  } else {
    for (const g of groupPills(domain)) {
      const kids = g.kids.filter((k) => visible(k.topic));
      if (!visible(g.parent)) {
        // 父标签自己没内容也没被选:它的可见子标签退化成平铺全名 pill(别让子标签凭空消失)。
        for (const k of kids) pushTopic(k.topic, k.topic.title, false);
        continue;
      }
      const parentPill = pushTopic(g.parent, g.parent.title, false);
      if (kids.length === 0) continue;
      // 有子标签:父 pill 右侧挂展开/收起箭头。默认收起;某子标签正被选中则自动展开(别把
      // 选中的筛选藏起来)。展开态在模块级 expandedParents(跨重投影存活)。
      const anyKidSelected = kids.some((k) => f.topics.includes(k.topic.id));
      const open = expandedParents.has(g.parent.id) || anyKidSelected;
      const caret = document.createElement("span");
      caret.className = "fcaret";
      caret.textContent = open ? "▾" : "▸";
      // 点箭头只翻子标签 pill 的显隐 + 箭头方向,**不走 onPick**——展开子标签不是筛选,
      // 不该被卡片草稿闸挡住,也不值得整条时间轴重投影。正被选中的子标签即便收起也留着
      // 可见(它是活着的筛选,不能藏)。
      caret.addEventListener("click", (e) => {
        e.stopPropagation(); // 别触发 pill 主体的「筛选」
        const now = !expandedParents.has(g.parent.id);
        if (now) expandedParents.add(g.parent.id);
        else expandedParents.delete(g.parent.id);
        caret.textContent = now ? "▾" : "▸";
        for (const el of bar.querySelectorAll<HTMLElement>(`.fpill.child[data-parent="${g.parent.id}"]`)) {
          el.classList.toggle("hidden", now ? false : !f.topics.includes(el.dataset.topicId ?? ""));
        }
      });
      parentPill.append(caret);
      for (const k of kids) {
        const kp = pushTopic(k.topic, k.label, true, g.parent.id);
        if (!open && !f.topics.includes(k.topic.id)) kp.classList.add("hidden");
      }
    }
  }
  bar.replaceChildren(...nodes);
}
