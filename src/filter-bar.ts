// 两维筛选(标签 pills + 文本过滤词)的共享件 —— 任务看板(105)与灵感同一套
// 筛选行为(单一真相源,同 hotkey-menu.ts 的抽法):列表内容 = 标签过滤 ∩ 文本过滤,
// 两维正交。筛选状态由各视图自己以模块态持有(「跨视图切换保留」的语义属于视图,
// 见 board.ts topicFilter 的注释),本件只提供纯函数应用 + pills/输入框的 DOM 行为。
import { t } from "./i18n";
import { INPUT_DEBOUNCE_MS } from "./timing";
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

// 「筛着标签建条目」该自动挂上的标签集 = 选集里的全部具体标签(用户 2026-08-31 拍板:
// 「相关的标签都打上才符合直觉」——此前只挂单选的那一枚,多选下刻意不挂改清筛选)。
// ⛔ "none"(无标签)剔掉:它不是标签,挂不上;只筛它时新条目天然无标签、本就可见。
// 空数组 = 没什么可挂 ⇒ 调用方改走「清掉筛选让新条目可见」那条路。
export function autoTagTopicIds(f: FilterState): string[] {
  return f.topics.filter((tok) => tok !== "none");
}

// 被筛具体标签的名字列表(供筛空空态提示「「A、B」下没有…」)。none 显「无标签」,
// id 解析成标签名(找不到 = 已删,显「该标签」占位)。空数组 = 未筛具体标签。
export function selectedTopicLabels(f: FilterState, allTopics: FilterTopic[]): string[] {
  return f.topics.map((tok) =>
    tok === "none" ? t("filter.none") : allTopics.find((tp) => tp.id === tok)?.title ?? t("filter.thatTag"),
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
//
// ⭐ 499 起 export:打标签选择器(tag-picker.ts)也要按同一口径分组。⛔ **别在那边另抄
// 一份** —— 前缀分组今天恰好三份复制品(这份 / 安卓 / topics.ts),`check-filter-parity`
// 逐字压着这三份;第四份出现它**不会自动发现**(那道闸自己的诚实边界)。
// 泛型只要 {id,title},门禁喂的 FilterTopic 与选择器的 PickerTopic 都满足。
export function groupPills<T extends { id: string; title: string }>(
  domain: T[],
): { parent: T; kids: { topic: T; label: string }[] }[] {
  const titles = new Set(domain.map((t) => t.title));
  const kidsOf = new Map<string, T[]>();
  const tops: T[] = [];
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
// 这里是干活时缩小视野)。allTopics 只在 kind 激活时用于把类型解析成标签 id 集
// ⚠ **两个视图都可能 kind ≠ all,两处都得传真的 allTopics**(此前这里写着「灵感恒
// kind="all",故不传也无妨」,随记接上类型轴之后就不成立了)。
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
    // 900 C6:名字单独一格(同安卓 `.flabel`)—— 超长标签名按行宽省略,计数照旧露在右端;此前整枚 nowrap 不能缩,
    // 窄窗口里被窗口边切掉。被省略时完整名字进 title(悬停那一刻量,窗口改过宽也准)。
    const l = document.createElement("span");
    l.className = "flabel";
    l.textContent = label;
    b.append(l, nEl);
    b.addEventListener("mouseenter", () => {
      const hint = b.dataset.topicId ? t("filter.pillTitle") : "";
      b.title = l.scrollWidth > l.clientWidth ? (hint ? `${label}
${hint}` : label) : hint;
    });
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
  // 623(用户面 74 / F):轴名小标,与类型轴 / 时间轴同形同皮肤 —— 此前三条轴里只有这一条
  // 没名字,pill 左缘比另两行短一个轴名的宽度(每张随记 / 任务图上都看得见)。
  // ⚠ 它不是 pill:check-filter-parity 的 serPills 只序列化 BUTTON 子节点,故这枚 span 不进
  // 那道闸的对账面,两端 pill 序列照旧逐字可比。
  const axis = document.createElement("span");
  axis.className = "tf-axis";
  axis.textContent = t("filter.topicAxis");
  const pills: HTMLElement[] = kindActive
    ? [axis, pill("all", t("filter.all"), scoped.length)]
    : [axis, pill("all", t("filter.all"), items.length), pill("none", t("filter.none"), none)];

  // 一个标签是否该出现:有条目 或 正被选中(选中的绝不因 0 计数消失)。
  const visible = (tp: FilterTopic) => (counts.get(tp.id) ?? 0) > 0 || f.topics.includes(tp.id);
  // 造一枚真标签 pill 并入列。child=true 的挂 .child + data-parent(供折叠显隐 + 缩进皮肤)。
  // 全部真标签 pill 都挂 data-topic-id(看板与随记据此接拖拽打标签,各自的 wireTagPills)。
  const pushTopic = (tp: FilterTopic, label: string, child: boolean, parentId?: string): HTMLElement => {
    const p = pill(tp.id, label, counts.get(tp.id) ?? 0, tp.color);
    p.dataset.topicId = tp.id;
    p.title = t("filter.pillTitle"); // 多选是隐藏能力,靠 hover 提示补可发现性
    // 计数为 0 = 这一族里的空位(499 起画得出来了,见下),弱化一档但仍可点(点了走
    // 「筛空」空态,那是有效回答)。
    if ((counts.get(tp.id) ?? 0) === 0) p.classList.add("empty");
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
      // ⭐ 499 起去留按**整族**算,不再逐枚按计数滤。
      // 此前的规则是「零计数的标签不画」,于是「父下有任务、子标签这阵子空着」时,子 pill
      // 被逐枚滤光 → `kids.length === 0` → 父 pill 上**连折叠箭头都不出**,屏上一点层级痕迹
      // 都没有(用户实报「看板上的标签层级怎么看不到了」;那两枚子标签下的任务只是做完
      // 归档了)。⇒ 族里但凡有一条内容,整族就画:父 + ▸ + 全部子,空的灰显(.empty)。
      // 整族零内容仍不画 —— 筛选条的口径还是「当前有什么可筛」,不是标签总目录。
      const kids = g.kids;
      if (!visible(g.parent) && !kids.some((k) => visible(k.topic))) continue;
      const parentPill = pushTopic(g.parent, g.parent.title, false);
      if (kids.length === 0) continue;
      // 有子标签:父 pill 挂展开/收起小箭头。默认收起;某子标签正被选中则自动展开(别把
      // 选中的筛选藏起来)。展开态在模块级 expandedParents(跨刷新存活)。
      const anyKidSelected = kids.some((k) => f.topics.includes(k.topic.id));
      const open = expandedParents.has(g.parent.id) || anyKidSelected;
      const caret = document.createElement("span");
      caret.className = "tf-caret";
      caret.textContent = open ? "▾" : "▸";
      caret.title = open ? t("filter.collapseKids") : t("filter.expandKids", { n: kids.length });
      // 点箭头只翻子标签 pill 的显隐 + 箭头方向,不整条重建(避开各视图 load/refresh 的指纹
      // 短路——它不认 expandedParents,会跳过重画)。正被选中的子标签即便收起也留着可见
      // (它是活着的筛选,不能藏)。
      caret.addEventListener("click", (e) => {
        e.stopPropagation(); // 别触发 pill 主体的「筛选」
        const now = !expandedParents.has(g.parent.id);
        if (now) expandedParents.add(g.parent.id);
        else expandedParents.delete(g.parent.id);
        caret.textContent = now ? "▾" : "▸";
        caret.title = now ? t("filter.collapseKids") : t("filter.expandKids", { n: kids.length });
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

  // 一枚真标签都画不出、也没在筛 ⇒ 这一行只剩「所有 / 无标签」,两枚都等于全集、什么也筛不出
  // ⇒ 整行不发(用户 10-10:刚开始还没标签时别占这一行)。判据与类型轴同形(没东西可筛就不出),
  // 按的是当前时间窗里的条目 —— 有标签但这批里一条都没挂,同样不出。⛔ 在筛「无标签」时留着:
  // 选中的筛选绝不从脚下消失(同上面 visible 那条)。安卓 filter.ts 同一条,check-filter-parity 两端同压。
  if (f.topics.length === 0 && !pills.some((p) => p.dataset.topicId)) {
    bar.replaceChildren();
    return;
  }

  // ⭐ 49:多选一直是个**隐藏能力** —— 桌面平点 = 只筛这一个、Ctrl/⌘ 点才是多选,而可
  // 发现性此前只有一句 hover title(用户据此以为「筛选不支持多标签」)。⇒ 筛着具体标签
  // 时在 pill 行尾挂一枚说明位,两态一个位置答完两件事:选 1 枚 = 教那个手势;选 ≥2 枚 =
  // 说清这是并集(挂其中任一个的条目都在,不是「同时挂全部」)。
  // ⛔ 不筛时整枚不发(只读面不常驻新元素);⛔ 只选「无标签」时也不发——它与具体标签
  // 互斥、不参与 Ctrl 多选(见上面 onclick),对它说「点另一枚可多选」是句假话。
  const picked = f.topics.filter((tok) => tok !== "none").length;
  if (picked > 0) {
    const hint = document.createElement("span");
    hint.className = "tf-hint";
    hint.textContent = picked === 1 ? t("filter.multiHint") : t("filter.unionHint", { n: picked });
    pills.push(hint);
  }
  bar.replaceChildren(...pills);
}

// ---- 标签行折叠(902 F5)------------------------------------------------------------
// 标签一多,这一行能折出五六行、把半屏内容顶下去(应用评审)。默认只显示**两行**,排不下的收起,行尾一枚
// 「更多 N ▾」,点开后变「收起 ▴」。规矩:
//  ① 正在筛选(选中)的标签即使排在折叠区也留在可见行(同上面「选中的不藏」);「所有 / 无标签」与行尾说明位不折;
//  ② 展开状态按视图记在 localStorage(这台屏幕怎么用,同侧栏折叠;不进库、不同步);
//  ③ 把卡片拖起来(拖到 pill 上 = 打标签)时自动展开,松手还原 —— 否则收起的标签接不到;
//  ④ 不满两行时什么都不出,与此前逐像素相同;
//  ⑤ 窗口变宽变窄、pill 重画、子标签 ▸/▾ 翻面都重算。
// ⚠ 「更多」钮是标签行**外面**的兄弟节点(插在 `.topic-filter` 后面):check-filter-parity 把行内每个 BUTTON 当标签核。
// ⚠ 整套接在行外(MutationObserver + ResizeObserver),⛔ 不改 renderFilterPills 一个字:那道闸把它的函数体切出去
//   单独求值,函数里引用任何本节的模块级名字都会在闸里 ReferenceError。
// 折起来的 pill 挂 `data-fold`(CSS 藏)。⛔ 不走 class:本节的观察器盯着子 pill 的 class(▸/▾ 翻的是 `.hidden`),
// 自己再改 class 就自激。

/** 这一行此刻排成几行。按「左缘回到上一枚的左边或原地 = 换行了」数(行内各枚高矮不一、`align-items:center`,
 *  拿 offsetTop 比会把同一行的高矮两枚数成两行)。只数真占位的(`offsetParent !== null`)。 */
function pillRows(bar: HTMLElement): number {
  let rows = 0;
  let prevLeft = Infinity;
  for (const c of bar.children) {
    const el = c as HTMLElement;
    if (el.offsetParent === null) continue;
    if (el.offsetLeft <= prevLeft) rows += 1;
    prevLeft = el.offsetLeft;
  }
  return rows;
}

const FOLD_ROWS = 2;

/** 给一条标签行接上「两行折叠」。`view` 进 localStorage 键名(看板 / 随记各记各的);`scope` = 这个视图的根
 *  (卡片的 dragstart / dragend 冒到它身上,监听随视图 DOM 一起走)。返回卸载钩(视图 unmount 时调)。 */
export function wireFilterFold(bar: HTMLElement, view: "board" | "inbox", scope: HTMLElement): () => void {
  const KEY = `zhujian.tagrows-open.${view}`;
  // 读不到 / 读失败 = 收起(默认那一边);写失败 = 这次照做、下次回默认,不为它报错(纯版式偏好)。
  let open = false;
  try {
    open = localStorage.getItem(KEY) === "1";
  } catch {
    open = false;
  }
  let dragOpen = false; // 拖卡片期间的临时展开(不写存储)

  const more = document.createElement("button");
  more.type = "button";
  more.className = "tf-more";
  more.hidden = true;
  if (bar.id) more.setAttribute("aria-controls", bar.id);
  const label = document.createElement("span");
  const arrow = document.createElement("span");
  arrow.className = "tf-more-arrow";
  arrow.setAttribute("aria-hidden", "true");
  more.append(label, arrow);
  bar.after(more);

  let busy = false; // 自己改 DOM 时观察器回调不重入
  const refold = (): void => {
    if (busy) return;
    busy = true;
    try {
      const pills = [...bar.querySelectorAll<HTMLElement>(":scope > .tf-pill")];
      for (const p of pills) delete p.dataset.fold;
      more.hidden = true;
      if (bar.children.length === 0 || pillRows(bar) <= FOLD_ROWS) return; // ④ 不满两行:什么都不出
      const expanded = open || dragOpen;
      more.hidden = false; // 先让它占位再量:它吃掉这一行右端的宽度
      more.setAttribute("aria-expanded", String(expanded));
      if (expanded) {
        label.textContent = t("filter.less");
        arrow.textContent = "▴";
        return;
      }
      // 能折的:真标签、没被选中、没被它的父收着(那些本来就不占位)。从行尾往回折,折到两行为止。
      const cand = pills.filter((p) => p.dataset.topicId && !p.classList.contains("active") && !p.classList.contains("hidden"));
      arrow.textContent = "▾";
      label.textContent = t("filter.more", { n: cand.length }); // 先按最宽的数字占位
      const hideLast = (k: number): void => {
        cand.forEach((p, i) => {
          if (i >= cand.length - k) p.dataset.fold = "1";
          else delete p.dataset.fold;
        });
      };
      // 折得越多行数越少(单调)⇒ 二分找最小的 k。全折了还超两行(选中的太多 / 窗太窄)就全折,不再硬压。
      let lo = 1;
      let hi = cand.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        hideLast(mid);
        if (pillRows(bar) <= FOLD_ROWS) hi = mid;
        else lo = mid + 1;
      }
      hideLast(lo);
      if (cand.length === 0) {
        more.hidden = true; // 没有一枚可折(全是选中的):钮点了也没用,不出
        return;
      }
      label.textContent = t("filter.more", { n: lo });
    } finally {
      busy = false;
    }
  };

  more.addEventListener("click", () => {
    open = !(open || dragOpen);
    dragOpen = false;
    try {
      localStorage.setItem(KEY, open ? "1" : "0");
    } catch {
      /* 见上:写不进去就只管这一次 */
    }
    refold();
  });

  // ③ 拖卡片:行外起的拖(卡片)才展开;拖的是 pill 自己(pill → 卡片那条路)不动。
  // ⚠ 展开放到下一拍:dragstart 里同步改版式(筛选行长高、卡片从指针下挪走)会让引擎当场取消这次拖。
  const onDragStart = (e: DragEvent): void => {
    if (open || more.hidden) return;
    if (e.target instanceof Node && bar.contains(e.target)) return;
    setTimeout(() => {
      dragOpen = true;
      refold();
    }, 0);
  };
  const onDragEnd = (): void => {
    // 同样排到下一拍:排在 dragstart 那一拍之后(一按即放的拖,两个事件可能挨着到)。
    setTimeout(() => {
      if (!dragOpen) return;
      dragOpen = false;
      refold();
    }, 0);
  };
  scope.addEventListener("dragstart", onDragStart);
  scope.addEventListener("dragend", onDragEnd);
  scope.addEventListener("drop", onDragEnd);

  // ⑤ pill 整行重画(childList)与子标签 ▸/▾ 翻面(子 pill 的 class)⇒ 重算;回调在微任务里,先于下一帧。
  const mo = new MutationObserver((list) => {
    if (list.some((m) => m.type === "childList" || (m.target as HTMLElement).classList.contains("child"))) refold();
  });
  mo.observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  // 行宽变了(窗口缩放 / 侧栏收放 / 字号档)⇒ 重算。折叠只改高度,宽度不变就不再进来,不会自激。
  let lastW = -1;
  const ro = new ResizeObserver(() => {
    const w = bar.clientWidth + more.offsetWidth;
    if (w === lastW) return;
    lastW = w;
    refold();
  });
  ro.observe(bar);
  refold();

  return () => {
    mo.disconnect();
    ro.disconnect();
    scope.removeEventListener("dragstart", onDragStart);
    scope.removeEventListener("dragend", onDragEnd);
    scope.removeEventListener("drop", onDragEnd);
  };
}

// 类型轴 pill 行(0031 kind):全部类型 + 库里出现过的每个 kind。仅当至少一个标签标了
// kind 才有内容(否则清空 bar,CSS `:empty` 隐藏整行——无 kind 就一条不多)。计数口径
// 同标签 pill:挂该类型任一标签的条目数(全量,不随文本收缩)。选一个 kind 会把标签轴
// 回落 所有(重新圈定,躲死筛)。⚠ **看板与随记两处都接**(此前这里写着「只看板接线,
// 灵感不调故无 kind 行」,随记接上之后没人回来改 —— 而正是那句话让 652 那个空态漏洞
// 看着不可能发生)。
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
    // 类型名也是用户起的 ⇒ 同标签 pill:名字单独一格、超宽省略,完整名字进 title(900 C6)。
    const l = document.createElement("span");
    l.className = "flabel";
    l.textContent = label;
    b.append(l);
    b.addEventListener("mouseenter", () => {
      b.title = l.scrollWidth > l.clientWidth ? label : "";
    });
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
  // 0 计数的类型不画,除非它正被选中(选择永不从脚下消失);一枚都画不出 ⇒ 整行不发,
  // 只剩一枚「全部类型」什么也筛不出(与标签行 10-10 那条同形;用户面 150 续)。
  const kindPills: HTMLElement[] = [];
  for (const k of kinds) {
    const ids = idsOfKind(allTopics, k);
    const n = items.filter((t) => t.topics.some((tp) => ids.has(tp.id))).length;
    if (n > 0 || f.kind === k) kindPills.push(pill(k, k, n));
  }
  if (kindPills.length === 0) {
    bar.replaceChildren();
    return;
  }
  const label = document.createElement("span");
  label.className = "tf-axis";
  label.textContent = t("filter.kindAxis");
  bar.replaceChildren(label, pill("all", t("filter.allKinds")), ...kindPills);
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

  // 去抖(340,§2.4 `INPUT_DEBOUNCE`)。`onChange` 是 board.load() / inbox.refresh(),
  // **两个都发 IPC 再全量重画** —— 此前逐字符打一次往返,一个四字词就是四次。
  //
  // 两条边界:
  //  · `f.text` 仍**当场**写。它是模块态,切视图回来 / 重挂要靠它恢复,不能等去抖窗口
  //    (窗口未闭合就切走 = 筛选词丢一半,正是 §六-1「状态归属」那族的形状)。
  //  · 遗留定时器打进死 mount 无害:两个目标都在头一行 `if (unmounted) return`
  //    (board.ts:1594 / inbox.ts:1149)。监听挂在 input 元素身上、随视图 DOM 一起消失,
  //    不是 §六-2 说的文档级监听,故这里不额外要 unmount 钩子。
  let timer: number | undefined;
  input.addEventListener("input", () => {
    f.text = input.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(onChange, INPUT_DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (input.value === "") {
      input.blur();
      return;
    }
    input.value = "";
    f.text = "";
    window.clearTimeout(timer); // 清词 = 「全部回来」,立即兑现,不排队等去抖
    onChange();
  });
}

// ---- 筛着时说「筛出 N 条」、过滤词标红(W3 159 / Q8,WD-20)----------------------------------
// 此前随记页 / 看板筛着「工作」+ 过滤「发票」只剩 4 张卡,页上没有条数、卡上那个词也不标红;搜索页两样都有。
// 两个视图同一套:条数挂在过滤框旁边那枚 `.filter-count`(两个 SKELETON 各一枚),标红走 `markFilterHits`。

/** 条数那一枚:`n === null` = 没在筛(收起);筛着就写「筛出 N 条」。筛空(0)交给视图的空态那句,这里收起。 */
export function paintFilterCount(slot: HTMLElement, n: number | null): void {
  slot.hidden = n === null || n === 0;
  slot.textContent = n === null ? "" : t("filter.count", { n });
}

/** 把 `root` 里出现的过滤词(同 applyFilter:整串、trim、不分大小写)包成 `<mark class="filter-hit">`。
 *  ⚠ 渲染**之后**走文本节点改,不碰正文渲染那条路(「图N」芯片、链接、清单方框都在,只是里面的字被包一层);
 *  ⛔ 不用 innerHTML。空词 = 什么也不做。 */
export function markFilterHits(root: HTMLElement, text: string): void {
  const q = text.trim().toLowerCase();
  if (q === "") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const s = node.data;
    const hay = s.toLowerCase();
    let at = hay.indexOf(q);
    if (at < 0) continue;
    const frag = document.createDocumentFragment();
    let from = 0;
    while (at >= 0) {
      if (at > from) frag.append(s.slice(from, at));
      const m = document.createElement("mark");
      m.className = "filter-hit";
      m.textContent = s.slice(at, at + q.length);
      frag.append(m);
      from = at + q.length;
      at = hay.indexOf(q, from);
    }
    if (from < s.length) frag.append(s.slice(from));
    node.replaceWith(frag);
  }
}

// ---- 时间轴(461)——独立于 kind/topics/text 三维,一个正交的第四轴。⚠ 不进
// check-filter-parity 的逐字一致门禁(先落桌面;安卓补齐同款后,把 timeBucketOf/
// applyTimeFilter/renderTimePills 登记进那道闸的 DESKTOP.fns)。
//
// 三档互斥分区,不是「近N天」层层嵌套的累计窗口:今天 / 昨天至6天前(第2~7天)/
// 更早(第8天起;157 起改了显示名,键名 1d/7d/old 不动)。三档相加=全量,故 "all" 是纯粹的重置态,不必再算并集。
// 按本地日历日算,同 due_on 的哲学——后端只搬运 created_at 时刻字符串,「今天」
// 从不由后端决定。
export type TimeBucket = "all" | "1d" | "7d" | "old";

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `created_at`(RFC3339)相对本地「今天」差几个日历日(0 = 今天,1 = 昨天…)。 */
function daysAgo(createdAt: string): number {
  return Math.round((startOfLocalDay(new Date()) - startOfLocalDay(new Date(createdAt))) / 86_400_000);
}

export function timeBucketOf(createdAt: string): Exclude<TimeBucket, "all"> {
  const n = daysAgo(createdAt);
  if (n <= 0) return "1d";
  if (n <= 6) return "7d";
  return "old";
}

export function applyTimeFilter<T>(items: T[], bucket: TimeBucket, createdAtOf: (item: T) => string): T[] {
  return bucket === "all" ? items : items.filter((it) => timeBucketOf(createdAtOf(it)) === bucket);
}

/** 这条轴在页上叫什么(898 D3)。轴按的一直是**创建时间**;随记页叫「时间」("time"),看板页叫「记于」("created")——
 *  看板页头那排「逾期 · 今天 · 3 天内」说的是到期日,筛选行再来一个「时间:今天」,两个「今天」挨着、说的不是一回事。
 *  ⛔ 调用方必须点名,不设默认。 */
export type TimeAxisName = "time" | "created";

/** 筛空时的补一句(157 G3 / WD-19):空态标题只说最具体的那一维(词 → 标签 → 类型 → 时间),
 *  其余还开着的维在这里点名 —— 此前三维叠着筛空,屏上只说「没有匹配「咖啡」」,清了词还是空,
 *  才发现时间与标签也选着。`said` = 标题已经说了哪一维(比它更具体的维此时必然没开)。
 *  返回 "" = 没有别的维在筛。 */
export function otherLayersNote(
  f: FilterState,
  all: FilterTopic[],
  time: TimeBucket,
  said: "text" | "topics" | "kind",
  axis: TimeAxisName,
): string {
  const parts: string[] = [];
  if (said === "text" && f.topics.length > 0) {
    parts.push(t("filter.layerTags", { labels: selectedTopicLabels(f, all).join(t("filter.layerSep")) }));
  }
  if (said !== "kind" && f.kind !== "all") parts.push(t("filter.layerKind", { kind: f.kind }));
  if (time !== "all") {
    const bucket = time === "1d" ? t("filter.time1d") : time === "7d" ? t("filter.time7d") : t("filter.timeOld");
    parts.push(axis === "created" ? t("filter.layerCreated", { time: bucket }) : t("filter.layerTime", { time: bucket }));
  }
  return parts.length ? t("filter.alsoActive", { layers: parts.join(t("filter.layerSep")) }) : "";
}

/** 时间轴 pill 行:全部 + 三档互斥分区。计数口径同类型轴 pill——挂哪一档的条目数
 * (全量,不随当前时间选中收缩)。时间与标签/类型正交:选时间不清标签选集(不像切
 * kind 那样是「重新圈定」,时间只是另一把独立的尺)。 */
export function renderTimePills<T>(
  bar: HTMLElement,
  items: T[],
  createdAtOf: (item: T) => string,
  current: TimeBucket,
  onPick: (bucket: TimeBucket) => void,
  axisName: TimeAxisName,
): void {
  const countOf = (bucket: TimeBucket) =>
    bucket === "all" ? items.length : items.filter((it) => timeBucketOf(createdAtOf(it)) === bucket).length;
  const pill = (bucket: TimeBucket, label: string) => {
    const b = document.createElement("button");
    b.className = `tf-pill${current === bucket ? " active" : ""}`;
    const nEl = document.createElement("span");
    nEl.className = "tf-n";
    nEl.textContent = String(countOf(bucket));
    b.append(document.createTextNode(label), nEl);
    b.onclick = () => onPick(bucket);
    return b;
  };
  const axis = document.createElement("span");
  axis.className = "tf-axis";
  axis.textContent = axisName === "created" ? t("filter.createdAxis") : t("filter.timeAxis");
  bar.replaceChildren(
    axis,
    pill("all", t("filter.all")),
    pill("1d", t("filter.time1d")),
    pill("7d", t("filter.time7d")),
    pill("old", t("filter.timeOld")),
  );
}
