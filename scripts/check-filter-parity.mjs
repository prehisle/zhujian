#!/usr/bin/env node
// 筛选纯逻辑在仓里有**两份近逐字的独立实现**——桌面共享件 src/filter-bar.ts 与安卓
// android/src/filter.ts(两个互不共享代码的 Vite 工程;后者文件头自述「复制纯逻辑……
// 严格一致」),前缀分组判据另有**第三份**:标签视图 src/topics.ts::groupByPrefix。
// 「严格一致」此前只是注释里的一句承诺,没有门禁对账——drift 才是真风险(照
// check-update-notes-predicate.mjs 的形立此闸)。跑法:node scripts/check-filter-parity.mjs
//
// 它测的是**真源码里的那些函数**(esbuild 现场转译后按函数名切出来),不是把逻辑再抄
// 一遍——抄一遍就成了自指的空测(292 判例);切不出来即响亮失败。渲染函数(父子折叠、
// 退化平铺、计数口径、点击选集)靠一个最小假 DOM 当**环境替身**压真函数:替身只提供
// createElement/append/classList 这些形状,不含任何筛选判断。两个方向都核:每一端都
// 对着同一张期望表,谁漂谁红。诚实边界(这道闸核不到什么)在输出末尾逐条印出。
import { build } from "esbuild";

// ---------------------------------------------------------------------------
// 提取真源码:esbuild 转译整个文件,再按函数名/常量名切出顶层声明,拼成 data: 模块。
// ---------------------------------------------------------------------------
function cutFn(text, entry, name) {
  const m = text.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`没在 ${entry} 里切出 ${name} —— 函数改名或换了写法?本检查须同改。`);
  return m[0];
}
function cutConst(text, entry, name) {
  const m = text.match(new RegExp(`const ${name} =[^\\n]*;`));
  if (!m) throw new Error(`没在 ${entry} 里切出常量 ${name} —— 改名或换了写法?本检查须同改。`);
  return m[0];
}

// 358 第②笔:pill 文案改走各端自己的字典(src/locales/ 与 android/src/locales/),切出来
// 的函数体里于是有 t() 调用,而 data: 模块带不动 import。**环境替身**的办法同假 DOM:
// 把该端**真字典**(esbuild 打包 locales/index.ts,纯数据、零外部依赖)塞进模块前言,
// 现场给一个 t。于是期望表照旧钉中文,并且顺带多核了一层:两份独立字典对同一枚 pill
// 必须说同一句话——一端把「所有」改成「全部」就红在这里。
// ⚠ 这个 t 是仿的(键缺失/占位符缺失都响亮,但插值语义与两端 i18n.ts 里的真 t 只是
//   「长得一样」,不是同一份代码):真 t 的行为由各端自己的类型与 check-i18n-drift 的
//   占位符奇偶闸看着,不在本闸的对账面(见文末诚实边界)。
async function loadDict(dictEntry) {
  const r = await build({ entryPoints: [dictEntry], bundle: true, write: false, format: "esm" });
  const mod = await import("data:text/javascript," + encodeURIComponent(r.outputFiles[0].text));
  return mod.messages;
}
function tPreamble(messages, dictEntry) {
  return (
    `const __MSG = ${JSON.stringify(messages)};\n` +
    `const __DICT = ${JSON.stringify(dictEntry)};\n` +
    // 抛之前把 stack 抹平:模块是 data: URL,默认栈帧会把整份字典的 URL 编码吐一屏,
    // 真正那句话被埋掉——「响亮」得读得见才算数。
    "function __die(msg) { const e = new Error(msg); e.stack = msg; throw e; }\n" +
    "function t(key, params) {\n" +
    "  const e = __MSG[key];\n" +
    "  if (!e) __die(`${__DICT} 里没有键 ${key} —— 两端键名须一致(见 check-i18n-drift 的 CROSS_END_KEYS)`);\n" +
    "  let s = e.zh;\n" +
    "  for (const [n, v] of Object.entries(params ?? {})) {\n" +
    "    const ph = `{${n}}`;\n" +
    "    if (!s.includes(ph)) __die(`${__DICT} 的 ${key} 缺占位符 ${ph}`);\n" +
    "    s = s.split(ph).join(String(v));\n" +
    "  }\n" +
    "  return s;\n" +
    "}"
  );
}

async function loadEnd({ entry, fns, consts, dict }) {
  const r = await build({ entryPoints: [entry], bundle: false, write: false, format: "esm" });
  const text = r.outputFiles[0].text;
  const pieces = [
    ...(dict ? [tPreamble(await loadDict(dict), dict)] : []),
    ...consts.map((n) => cutConst(text, entry, n)),
    ...fns.map((n) => cutFn(text, entry, n)),
  ];
  const src = pieces.join("\n") + `\nexport { ${fns.join(", ")} };`;
  return await import("data:text/javascript," + encodeURIComponent(src));
}

const DESKTOP = {
  label: "桌面",
  entry: "src/filter-bar.ts",
  dict: "src/locales/index.ts",
  consts: ["expandedParents"],
  fns: [
    "filterActive", "soleTopicFilter", "selectedTopicLabels", "idsOfKind", "groupPills",
    "reconcileTopicFilter", "reconcileKindFilter", "applyFilter", "renderFilterPills", "renderKindPills",
  ],
  renderTopics: "renderFilterPills",
  clickStyle: "mutate", // 桌面:onclick 直改 f、再叫 onChange()
};
const ANDROID = {
  label: "安卓",
  entry: "android/src/filter.ts",
  dict: "android/src/locales/index.ts",
  consts: ["expandedParents"],
  fns: [
    "filterActive", "soleTopicFilter", "selectedTopicLabels", "idsOfKind", "pill", "groupPills",
    "reconcileTopicFilter", "reconcileKindFilter", "applyFilter", "renderTopicPills", "renderKindPills",
  ],
  renderTopics: "renderTopicPills",
  clickStyle: "patch", // 安卓:onPick(patch),不直改 f(草稿闸在主视图)
};
// groupByPrefix 是纯串处理、不碰文案,故不必给字典(dict 省略 = 不注入 t)。
const TOPICS_VIEW = { label: "标签视图", entry: "src/topics.ts", consts: [], fns: ["groupByPrefix"] };

// ---------------------------------------------------------------------------
// 最小假 DOM(环境替身,不是逻辑替身):只提供渲染函数摸得到的形状。
// ---------------------------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.cls = new Set();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.listeners = new Map();
    this.title = "";
    this.type = "";
    this.onclick = null;
    this._text = "";
  }
  get className() { return [...this.cls].join(" "); }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const cls = this.cls;
    return {
      add: (...cs) => { for (const c of cs) cls.add(c); },
      remove: (...cs) => { for (const c of cs) cls.delete(c); },
      contains: (c) => cls.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !cls.has(c) : !!force;
        if (on) cls.add(c); else cls.delete(c);
        return on;
      },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, fn) { const a = this.listeners.get(type) ?? []; a.push(fn); this.listeners.set(type, a); }
  querySelectorAll() { return []; } // 只有 caret 点击处理器用它;本闸不点 caret(见诚实边界)
}
globalThis.document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, text: String(t) }),
};

// ---------------------------------------------------------------------------
// 夹具:一套标签宇宙 + 一套条目,所有用例共用(id 稳定,期望表可读)。
// ---------------------------------------------------------------------------
const T = {
  work:   { id: "t_work",   title: "工作",          color: "#a33", kind: "领域" },
  workA:  { id: "t_work_a", title: "工作/甲方",      color: null,   kind: "领域" },
  workB:  { id: "t_work_b", title: "工作/乙方",      color: null,   kind: null },
  deep:   { id: "t_deep",   title: "工作/甲方/深层",  color: null,   kind: null },
  life:   { id: "t_life",   title: "生活",          color: null,   kind: null },
  zhu:    { id: "t_zhu",    title: "朱简",          color: "#c00", kind: "人名" },
  lead:   { id: "t_lead",   title: "/开头",         color: null,   kind: null },
  tail:   { id: "t_tail",   title: "结尾",          color: null,   kind: null },
  tailS:  { id: "t_tail_s", title: "结尾/",         color: null,   kind: null },
  orphan: { id: "t_orphan", title: "孤儿/子",       color: null,   kind: null },
};
const ALL = [T.work, T.workA, T.workB, T.deep, T.life, T.zhu, T.lead, T.tail, T.tailS, T.orphan];

const it = (id, text, ...tps) => ({ id, text, topics: tps.map((t) => ({ id: t.id })) });
const ITEMS = [
  it("A", "写周报", T.work),
  it("B", "对甲方的合同", T.workA),
  it("C", "买菜 LIST", T.life),
  it("D", "无标签的碎念"),
  it("E", "朱简的想法", T.zhu, T.work),
  it("F", "乙方回款", T.workB),
];
const items = (...ids) => ids.map((id) => ITEMS.find((i) => i.id === id));

const F = (kind, topics, text) => ({ kind, topics, text });
const cf = (f) => ({ kind: f.kind, topics: [...f.topics], text: f.text });
const serState = (f) => `kind=${f.kind} topics=[${f.topics.join("|")}]`;

// ---------------------------------------------------------------------------
// 用例表(期望值手写,两端各自对表——两端一起漂也逮得住)。
// ---------------------------------------------------------------------------
// applyFilter:[描述, 筛选态, 期望条目 id 序列]
const APPLY_CASES = [
  ["空筛选=全部", F("all", [], ""), "A,B,C,D,E,F"],
  ["单标签", F("all", ["t_work"], ""), "A,E"],
  ["③ 标签多选走「或」并集:工作∪生活", F("all", ["t_work", "t_life"], ""), "A,C,E"],
  ["「无标签」token 只出无标签条目", F("all", ["none"], ""), "D"],
  ["applyFilter 对 none+具体标签仍按 OR(互斥是选集闸的事,见点击用例)", F("all", ["none", "t_life"], ""), "C,D"],
  ["kind 圈定:挂该类型任一标签的条目", F("领域", [], ""), "A,B,E"],
  ["kind→topics 顺序:类型内再钻具体标签", F("领域", ["t_work_a"], ""), "B"],
  ["文本:trim+忽略大小写", F("all", [], "  List "), "C"],
  ["三维叠加 kind→topics→text", F("领域", ["t_work"], "周"), "A"],
  ["④ 死标签不 reconcile 就进 applyFilter=筛空(不静默回落)", F("all", ["ghost"], ""), ""],
  ["kind 态下 none 恒空(挂类型标签的条目必有标签)", F("领域", ["none"], ""), ""],
];
// reconcileTopicFilter:[描述, 选集入, 选集出]
const RT_CASES = [
  ["④ 死标签剔出选集、none 与活标签保留、保序", ["t_work", "ghost", "none"], "t_work|none"],
  ["④ 全死→空选集(回「所有」)", ["g1", "g2"], ""],
  ["空选集不动", [], ""],
];
// reconcileKindFilter:[描述, {kind,topics} 入, 期望态]
const RK_CASES = [
  ["④ 死类型→回「全部类型」,选集原样留给 reconcileTopicFilter", F("幽灵类型", ["t_work", "none"], ""), "kind=all topics=[t_work|none]"],
  ["① kind 圈定后:none 与异类标签清出选集", F("领域", ["none", "t_life", "t_work"], ""), "kind=领域 topics=[t_work]"],
  ["kind 内的具体标签保留", F("领域", ["t_work_a"], ""), "kind=领域 topics=[t_work_a]"],
  ["① 选集全不属该 kind→标签轴归零", F("人名", ["t_work"], ""), "kind=人名 topics=[]"],
  ["kind=all 早退、不动选集(死 id 归 reconcileTopicFilter 管)", F("all", ["ghost", "none"], ""), "kind=all topics=[ghost|none]"],
];
// filterActive / soleTopicFilter / selectedTopicLabels
const FA_CASES = [
  ["三维全空=非筛选态", F("all", [], ""), "false"],
  ["纯空白文本不算激活(trim)", F("all", [], "   "), "false"],
  ["kind 单独激活", F("领域", [], ""), "true"],
  ["none 单独激活", F("all", ["none"], ""), "true"],
  ["文本单独激活", F("all", [], "x"), "true"],
];
const SOLE_CASES = [
  ["恰一枚具体标签→返它的 id", ["t_work"], "t_work"],
  ["只选「无标签」不算", ["none"], "null"],
  ["多选不算(chip 要表明凭哪个入选)", ["t_work", "t_life"], "null"],
  ["空选集不算", [], "null"],
];
const LABEL_CASES = [
  ["none→「无标签」,活 id→标题,死 id→「该标签」占位", ["none", "t_work", "ghost"], "无标签|工作|该标签"],
];
// 前缀分组(三份同压):[描述, domain, 期望 "父[子标签…] · 平铺…"]
const GROUP_CASES = [
  ["全宇宙:一层分组+平铺共存", ALL, "工作[甲方|乙方|甲方/深层] · 生活 · 朱简 · /开头 · 结尾 · 结尾/ · 孤儿/子"],
  ["子在父前也归组(titles 先建全集)", [T.workA, T.work], "工作[甲方]"],
  ["仅当存在同名父才算子:无父则平铺全名", [T.workA, T.workB], "工作/甲方 · 工作/乙方"],
  ["尾斜杠不算分组(即便同名父在场)", [T.tail, T.tailS], "结尾 · 结尾/"],
  ["首斜杠不算分组", [T.lead], "/开头"],
  ["只按第一段分一层,多级斜杠不再细分", [T.work, T.deep], "工作[甲方/深层]"],
];
// 标签 pill 行(假 DOM 压真渲染):[描述, allTopics, items, f, 期望序列]
// 记法:label:计数  *=active  °=色点  ▸/▾=折叠箭头  <id=child 挂父  …=hidden
const RENDER_CASES = [
  ["⑤ 父标签不可见(0 计数且未选)→子标签退化平铺全名", [T.work, T.workA], items("B"), F("all", [], ""),
    "所有:1* | 无标签:0 | 工作/甲方:1"],
  ["父子分组默认收起:子 pill 在场但 hidden、父挂 ▸", [T.work, T.workA], items("A", "B"), F("all", [], ""),
    "所有:2* | 无标签:0 | 工作:1°▸ | 甲方:1<t_work…"],
  ["子标签被选→自动展开+active(活着的筛选不能藏)", [T.work, T.workA], items("A", "B"), F("all", ["t_work_a"], ""),
    "所有:2 | 无标签:0 | 工作:1°▾ | 甲方:1*<t_work"],
  ["kind 激活:收进该类型、不画「无标签」、不分组保持扁平", ALL, items("A", "B", "C", "D", "E", "F"), F("领域", [], ""),
    "所有:3* | 工作:2° | 工作/甲方:1"],
  ["0 计数标签隐藏", [T.work, T.life], items("A"), F("all", [], ""),
    "所有:1* | 无标签:0 | 工作:1°"],
  ["0 计数但被选→仍在场(选择永不从脚下消失)", [T.work, T.life], items("A"), F("all", ["t_life"], ""),
    "所有:1 | 无标签:0 | 工作:1° | 生活:0*"],
  ["父 0 计数但被选→父在场带 ▸,子照常归组", [T.work, T.workA], items("B"), F("all", ["t_work"], ""),
    "所有:1 | 无标签:0 | 工作:0*°▸ | 甲方:1<t_work…"],
];
// 类型 pill 行:[描述, allTopics, items, f, 期望序列]
const KINDROW_CASES = [
  ["kind 首现序+全量计数(挂该类型任一标签的条目数)", ALL, items("A", "B", "C", "D", "E", "F"), F("all", [], ""),
    "全部类型* | 领域:3 | 人名:1"],
  ["选中态高亮跟 f.kind", ALL, items("A", "B", "C", "D", "E", "F"), F("人名", [], ""),
    "全部类型 | 领域:3 | 人名:1*"],
  ["库里无 kind→整行清空(CSS :empty 隐藏)", [T.life, T.tail], items("C"), F("all", [], ""), "(空)"],
];
// 点击语义(桌面走 Ctrl 多选路径,与安卓点按切换是同一套共享语义;桌面平点=替换是
// 桌面独有惯例,无对照对象,见诚实边界):[描述, 行, all, items, f0, 点哪枚, ctrl?, 期望态]
const CLICK_CASES = [
  ["② 选着「无标签」再点具体标签→none 被清(互斥)", "topics", [T.work, T.life], items("A"), F("all", ["none"], ""), "工作", true, "kind=all topics=[t_work]"],
  ["② 选着具体标签再点「无标签」→具体标签被清(互斥)", "topics", [T.work, T.life], items("A"), F("all", ["t_work"], ""), "无标签", false, "kind=all topics=[none]"],
  ["③ 多选切入:并集加一枚", "topics", [T.work, T.life], items("A", "C"), F("all", ["t_work"], ""), "生活", true, "kind=all topics=[t_work|t_life]"],
  ["③ 多选切出:再点已选的那枚", "topics", [T.work, T.life], items("A", "C"), F("all", ["t_work", "t_life"], ""), "工作", true, "kind=all topics=[t_life]"],
  ["「无标签」自身点按切换关", "topics", [T.work, T.life], items("A"), F("all", ["none"], ""), "无标签", false, "kind=all topics=[]"],
  ["「所有」=清空选集", "topics", [T.work, T.life], items("A", "C"), F("all", ["t_work", "t_life"], ""), "所有", false, "kind=all topics=[]"],
  ["① 选中一个类型→标签轴归零", "kind", ALL, items("A", "B", "C", "D", "E", "F"), F("all", ["t_work"], ""), "领域", false, "kind=领域 topics=[]"],
  ["① 回「全部类型」同样归零标签轴", "kind", ALL, items("A", "B", "C", "D", "E", "F"), F("领域", ["t_work"], ""), "全部类型", false, "kind=all topics=[]"],
];

// ---------------------------------------------------------------------------
// 序列化与断言
// ---------------------------------------------------------------------------
function pillLabel(b) {
  let s = "";
  for (const c of b.children) if (c && c.nodeType === 3) s += c.text;
  return s;
}
function normPill(b) {
  let count = null, dot = false, caret = null;
  for (const c of b.children) {
    if (!(c instanceof El)) continue;
    if (c.cls.has("fn") || c.cls.has("tf-n")) count = c._text;
    else if (c.cls.has("fdot") || c.cls.has("tf-dot")) dot = true;
    else if (c.cls.has("fcaret") || c.cls.has("tf-caret")) caret = c._text;
  }
  return (
    pillLabel(b) + (count === null ? "" : `:${count}`) + (b.cls.has("active") ? "*" : "") +
    (dot ? "°" : "") + (caret ?? "") +
    (b.cls.has("child") ? `<${b.dataset.parent ?? "?"}` : "") + (b.cls.has("hidden") ? "…" : "")
  );
}
function serPills(bar) {
  const btns = bar.children.filter((c) => c instanceof El && c.tagName === "BUTTON");
  return btns.length ? btns.map(normPill).join(" | ") : "(空)";
}
function serGroups(groups) {
  return groups
    .map((g) => {
      // 两族键名不同:filter 件叫 kids、topics.ts 叫 children —— 只做键名适配,不碰判据。
      const kids = g.kids ?? g.children;
      return kids.length ? `${g.parent.title}[${kids.map((k) => k.label).join("|")}]` : g.parent.title;
    })
    .join(" · ");
}

let fail = 0, total = 0;
function check(label, got, want) {
  total += 1;
  if (got === want) {
    console.log(`✅ ${label}`);
  } else {
    fail += 1;
    console.log(`❌ ${label}`);
    console.log(`   期望:${want}`);
    console.log(`   实得:${got}`);
  }
}

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------
const desktop = await loadEnd(DESKTOP);
const android = await loadEnd(ANDROID);
const topicsView = await loadEnd(TOPICS_VIEW);
const ENDS = [
  { ...DESKTOP, mod: desktop },
  { ...ANDROID, mod: android },
];

console.log("=== 纯逻辑:applyFilter / reconcile* / filterActive / soleTopicFilter / selectedTopicLabels ===");
for (const end of ENDS) {
  const m = end.mod;
  console.log(`--- ${end.label}(${end.entry})---`);
  for (const [desc, f, want] of APPLY_CASES) {
    const got = m.applyFilter(ITEMS, cf(f), (i) => i.text, ALL).map((i) => i.id).join(",");
    check(`[${end.label}] applyFilter:${desc}`, got, want);
  }
  for (const [desc, topics, want] of RT_CASES) {
    const f = F("all", topics, "");
    m.reconcileTopicFilter(f, ALL);
    check(`[${end.label}] reconcileTopicFilter:${desc}`, f.topics.join("|"), want);
  }
  for (const [desc, f0, want] of RK_CASES) {
    const f = cf(f0);
    m.reconcileKindFilter(f, ALL);
    check(`[${end.label}] reconcileKindFilter:${desc}`, serState(f), want);
  }
  for (const [desc, f, want] of FA_CASES) check(`[${end.label}] filterActive:${desc}`, String(m.filterActive(cf(f))), want);
  for (const [desc, topics, want] of SOLE_CASES) check(`[${end.label}] soleTopicFilter:${desc}`, String(m.soleTopicFilter(F("all", topics, ""))), want);
  for (const [desc, topics, want] of LABEL_CASES) check(`[${end.label}] selectedTopicLabels:${desc}`, m.selectedTopicLabels(F("all", topics, ""), ALL).join("|"), want);
}

console.log("\n=== 前缀分组:桌面 groupPills / 安卓 groupPills / 标签视图 groupByPrefix(三份同压)===");
const GROUP_TARGETS = [
  { label: "桌面", fn: desktop.groupPills },
  { label: "安卓", fn: android.groupPills },
  { label: "标签视图", fn: topicsView.groupByPrefix },
];
for (const t of GROUP_TARGETS) {
  for (const [desc, domain, want] of GROUP_CASES) {
    check(`[${t.label}] 分组:${desc}`, serGroups(t.fn(domain)), want);
  }
}

console.log("\n=== 渲染结构:标签 pill 行 / 类型 pill 行(假 DOM 压真渲染函数)===");
for (const end of ENDS) {
  for (const [desc, all, its, f, want] of RENDER_CASES) {
    const bar = new El("div");
    end.mod[end.renderTopics](bar, its, all, cf(f), () => {});
    check(`[${end.label}] 标签行:${desc}`, serPills(bar), want);
  }
  for (const [desc, all, its, f, want] of KINDROW_CASES) {
    const bar = new El("div");
    end.mod.renderKindPills(bar, its, all, cf(f), () => {});
    check(`[${end.label}] 类型行:${desc}`, serPills(bar), want);
  }
}

console.log("\n=== 点击语义:互斥 / 多选切换 / 归零(桌面取 Ctrl 多选路径)===");
for (const end of ENDS) {
  for (const [desc, row, all, its, f0, pick, ctrl, want] of CLICK_CASES) {
    const f = cf(f0);
    const bar = new El("div");
    let patch = null, changed = false;
    const cb = end.clickStyle === "patch" ? (p) => { patch = p; } : () => { changed = true; };
    const render = row === "kind" ? end.mod.renderKindPills : end.mod[end.renderTopics];
    render(bar, its, all, f, cb);
    const node = bar.children.find((c) => c instanceof El && c.tagName === "BUTTON" && pillLabel(c) === pick);
    let got;
    if (!node) {
      got = `(没找到 pill「${pick}」,行内实为:${serPills(bar)})`;
    } else {
      const ev = { ctrlKey: !!ctrl, metaKey: false, stopPropagation() {} };
      if (node.onclick) node.onclick(ev);
      else if (node.listeners.get("click")?.length) node.listeners.get("click")[0](ev);
      else { got = "(pill 上没有任何点击处理器)"; }
      if (got === undefined) {
        if (end.clickStyle === "patch") got = patch === null ? "(点了但 onPick 没收到回执)" : serState({ ...f, ...patch });
        else got = changed ? serState(f) : "(点了但 onChange 没被叫)";
      }
    }
    check(`[${end.label}] 点击:${desc}`, got, want);
  }
}

// ---------------------------------------------------------------------------
// 判定 + 诚实边界
// ---------------------------------------------------------------------------
console.log(`
—— 诚实边界(这道闸核不到的)——
· 桌面「单击=替换单选、Ctrl/⌘=多选」是桌面独有交互惯例(filter-bar.ts 内有记档,安卓
  刻意保持点按切换):本闸只对拍两端共享的「切换/互斥/清空」语义(桌面走 Ctrl 路径),
  桌面平点的替换行为无对照对象、不在对账面。
· 渲染只对拍 pill 序列的结构事实(文案/计数/active/child/hidden/caret/色点/父挂钩);
  class 名、tooltip、CSS 造型、事件绑定方式两端本就不同,不核。
· caret 点击后的子 pill 显隐翻转与 expandedParents 跨渲染留存要真 DOM 查询
  (querySelectorAll),假 DOM 不覆盖;wireFilterInput(去抖/Esc)桌面独有,无对照。
· groupPills 与 topics.ts groupByPrefix 输出仅键名不同(kids/children),序列化做了
  键名适配;分组判据(同名父/首段一层/首尾斜杠)三份同压全部用例。
· 「/开头」守卫(i>0)与 titles.has("") 互为冗余:除非存在空标题标签,单独变异它不可
  观测——用例钉得住行为(平铺),钉不住那半句代码。
· 按函数名切真源码:改名/换写法即响亮失败(fail-closed);但哪天再出现第四份复制品,
  本闸不会自动发现它。
· pill 文案取自两端**各自的真字典**(zh 档),故「两份字典对同一枚 pill 说不同的话」逮得住;
  但模块前言里那个 t 是仿的——真 t 的插值与缺键行为由各端 i18n.ts 与 check-i18n-drift
  (占位符奇偶 / 键双向)看着,不在本闸的对账面。en 档不在本闸的对账面(期望表钉 zh)。`);
console.log(
  fail === 0
    ? `\n${total} 条全过 —— 两端筛选纯逻辑 + 三份前缀分组口径一致。`
    : `\n${fail}/${total} 条不符 —— 筛选逻辑已 drift,先对齐再过闸。`,
);
process.exit(fail === 0 ? 0 : 1);
