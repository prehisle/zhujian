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
// topics: 被选中的标签集,**OR/并集语义**——空数组 = 「所有」(不按标签筛);元素为
// "none"(无标签)或某 topic id;同时选中多个 = 显示挂了其中任一标签的条目(如 zhujian
// + saiai = 带 zhujian 或 saiai 的任务)。text: 原始输入(trim + 忽略大小写). 应用顺序
// kind → topics → text;kind 是「钻取器」——选中一个类型先圈定「挂了该类型任一标签的
// 条目」,再把标签 pill 收到该类型内(见 renderFilterPills / renderKindPills)。
export type FilterState = { kind: string; topics: string[]; text: string };

// 任一维激活即「筛选态」(看板拿它路由 visible-merge 拖拽)。
export function filterActive(f: FilterState): boolean {
  return f.kind !== "all" || f.topics.length > 0 || f.text.trim() !== "";
}

// 当前是否恰好只筛了「单一具体标签」(非无标签)——返回它的 id,否则 null。用于「卡片
// 隐藏那枚重复 chip」(218):单选时同名 chip 是纯冗余;多选 OR 下每枚 chip 表明「凭哪个
// 标签入选」是有效信息、不该藏。也用于「筛着标签建条目自动挂该标签」(唯一归属才明确)。
export function soleTopicFilter(f: FilterState): string | null {
  return f.topics.length === 1 && f.topics[0] !== "none" ? f.topics[0] : null;
}

// 被筛具体标签的中文名列表(供筛空空态提示「「A、B」下没有…」)。none 显「无标签」,
// id 解析成标签名(找不到 = 已删,显「该标签」占位)。空数组 = 未筛具体标签。
export function selectedTopicLabels(f: FilterState, allTopics: FilterTopic[]): string[] {
  return f.topics.map((tok) =>
    tok === "none" ? "无标签" : allTopics.find((t) => t.id === tok)?.title ?? "该标签",
  );
}

// The topic ids belonging to a given kind — the bridge from the kind axis (which lives
// on allTopics) to per-item topics (which carry only ids). 空 kind/无匹配 = 空集。
function idsOfKind(allTopics: FilterTopic[], kind: string): Set<string> {
  return new Set(allTopics.filter((t) => t.kind === kind).map((t) => t.id));
}

// 筛选条里「已展开子标签」的父标签集(0031 需求扩展:父子标签在筛选条折叠)。默认收起
// (不在集里 = 子标签 pill 藏起来),点父 pill 上的小箭头翻。模块级——跨刷新存活(避开各
// 视图 load/refresh 指纹短路),看板与灵感共享一份(标签层级两端相同,展开态一致即可)。
const expandedParents = new Set<string>();

// 把 domain 标签按 `父/子` 前缀分组(与标签视图 topics.ts::groupByPrefix 同规:仅当存在
// 同名父标签才算子;首尾斜杠不算)。返回顶层序(保 domain 原序)+ 每个顶层的子标签(后缀
// 标签)。只按第一段分一层,多级斜杠不再细分;没有同名父的照平铺。
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

// If the active filter points at a topic that no longer exists (deleted/merged),
// fall back to 所有 rather than showing a dead filter. Pure state fix (no DOM) —
// must run before the caller fingerprints the render.
export function reconcileTopicFilter(f: FilterState, allTopics: FilterTopic[]): void {
  // 逐 token 保留:none 恒有效,id 须仍存在(删/合并后消失的从选集里剔掉)。
  f.topics = f.topics.filter((tok) => tok === "none" || allTopics.some((t) => t.id === tok));
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
  // 类型内只留属于该类型的具体标签(none 不属任何类型、类型态也不画无标签 pill)。
  f.topics = f.topics.filter((tok) => tok !== "none" && ids.has(tok));
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
    // 「所有」在选集为空时高亮;其余 pill 在被选中(在选集里)时高亮——多选可同时多个高亮。
    const on = key === "all" ? f.topics.length === 0 : f.topics.includes(key);
    b.className = `tf-pill${on ? " active" : ""}`;
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
    b.onclick = (e) => {
      // 桌面交互:平时**单击 = 只筛这一个标签**(替换选集,再点它自己 = 取消回「所有」);
      // 按住 **Ctrl/⌘ 单击 = 多选**(把标签切进/切出 OR 并集)。「所有」= 清空选集(回到
      // 不筛)。「无标签」与具体标签**互斥**——一个条目不可能既无标签又挂着某标签,把两者
      // OR 到一起是无意义的并集,故它只单击切换、不参与 Ctrl 多选。(安卓触屏无 Ctrl,其
      // 独立件 android/src/filter.ts 保持点按切换的多选,不受此桌面单选惯例影响。)
      const multi = e.ctrlKey || e.metaKey;
      if (key === "all") {
        f.topics = [];
      } else if (key === "none") {
        f.topics = f.topics.includes("none") ? [] : ["none"];
      } else if (multi) {
        const rest = f.topics.filter((t) => t !== "none");
        const i = rest.indexOf(key);
        if (i >= 0) rest.splice(i, 1);
        else rest.push(key);
        f.topics = rest;
      } else {
        // 单选替换:已是唯一选中项则取消(回「所有」),否则只留这一个。
        f.topics = f.topics.length === 1 && f.topics[0] === key ? [] : [key];
      }
      onChange();
    };
    return b;
  };
  const pills: HTMLElement[] = kindActive
    ? [pill("all", "所有", scoped.length)]
    : [pill("all", "所有", items.length), pill("none", "无标签", none)];

  // 一个标签是否该出现:有条目 或 正被选中(选中的绝不因 0 计数消失)。
  const visible = (tp: FilterTopic) => (counts.get(tp.id) ?? 0) > 0 || f.topics.includes(tp.id);
  // 造一枚真标签 pill 并入列。child=true 的挂 .child + data-parent(供折叠显隐 + 缩进皮肤)。
  // 全部真标签 pill 都挂 data-topic-id(看板据此接拖拽打标签;灵感侧不接线故无副作用)。
  const pushTopic = (tp: FilterTopic, label: string, child: boolean, parentId?: string): HTMLElement => {
    const p = pill(tp.id, label, counts.get(tp.id) ?? 0, tp.color);
    p.dataset.topicId = tp.id;
    p.title = "单击只筛此标签 · 按住 Ctrl 多选"; // 多选是隐藏能力,靠 hover 提示补可发现性
    if (child) {
      p.classList.add("child");
      if (parentId) p.dataset.parent = parentId;
    }
    pills.push(p);
    return p;
  };

  if (kindActive) {
    // 类型态:标签已按 kind 圈定,不做前缀分组(保持扁平,drill 语义单纯)。
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
      // 有子标签:父 pill 挂展开/收起小箭头。默认收起;某子标签正被选中则自动展开(别把
      // 选中的筛选藏起来)。展开态在模块级 expandedParents(跨刷新存活)。
      const anyKidSelected = kids.some((k) => f.topics.includes(k.topic.id));
      const open = expandedParents.has(g.parent.id) || anyKidSelected;
      const caret = document.createElement("span");
      caret.className = "tf-caret";
      caret.textContent = open ? "▾" : "▸";
      caret.title = open ? "收起子标签" : `展开 ${kids.length} 个子标签`;
      // 点箭头只翻子标签 pill 的显隐 + 箭头方向,不整条重建(避开各视图 load/refresh 的指纹
      // 短路——它不认 expandedParents,会跳过重画)。正被选中的子标签即便收起也留着可见
      // (它是活着的筛选,不能藏)。
      caret.addEventListener("click", (e) => {
        e.stopPropagation(); // 别触发 pill 主体的「筛选」
        const now = !expandedParents.has(g.parent.id);
        if (now) expandedParents.add(g.parent.id);
        else expandedParents.delete(g.parent.id);
        caret.textContent = now ? "▾" : "▸";
        caret.title = now ? "收起子标签" : `展开 ${kids.length} 个子标签`;
        for (const el of bar.querySelectorAll<HTMLElement>(`.tf-pill.child[data-parent="${g.parent.id}"]`)) {
          const keep = !now && !f.topics.includes(el.dataset.topicId ?? "");
          el.classList.toggle("hidden", now ? false : keep);
        }
      });
      parentPill.append(caret);
      for (const k of kids) {
        const kp = pushTopic(k.topic, k.label, true, g.parent.id);
        if (!open && !f.topics.includes(k.topic.id)) kp.classList.add("hidden");
      }
    }
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
      f.topics = []; // 切类型 = 重新圈定,标签轴归零(reconcileKindFilter 亦保此)
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
