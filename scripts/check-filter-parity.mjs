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
    "filterActive", "soleTopicFilter", "autoTagTopicIds", "selectedTopicLabels", "idsOfKind", "groupPills",
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
    "filterActive", "soleTopicFilter", "autoTagTopicIds", "selectedTopicLabels", "idsOfKind", "pill", "groupPills",
    "reconcileTopicFilter", "reconcileKindFilter", "applyFilter", "renderTopicPills", "renderKindPills",
  ],
  renderTopics: "renderTopicPills",
  clickStyle: "patch", // 安卓:onPick(patch),不直改 f(草稿闸在主视图)
};
// groupByPrefix 是纯串处理、不碰文案,故不必给字典(dict 省略 = 不注入 t)。
const TOPICS_VIEW = { label: "标签视图", entry: "src/topics.ts", consts: [], fns: ["groupByPrefix"] };
// 正文待办清单的认行 / 翻标记(src/checklist.ts 与 android/src/checklist.ts,又一对逐字
// 复制的纯逻辑)。⛔ **并进本闸而不另开一道** —— 门禁停止扩张线(383)那条判据:先问
// 「能不能并进已有某道」。同样是纯串处理,不碰文案,不给字典。
// ⭐ 562 起多三个(快速输入那半):续行 / 起一条 / 最小改写区间。前两个是**用户手势的
// 语义**、第三个是接线层落笔的算式,三者全是纯串处理,同样两端逐字对应、同样在这道闸里压。
// ⭐ 600 再多一个:缩进 / 反缩进(桌面 Tab / Shift+Tab)。⚠ **安卓那一端没有接线**
// (软键盘上没有 Tab),但纯逻辑那份仍逐字对应 ⇒ 照样两端同压 —— 对拍的是「两份纯逻辑
// 一不一样」,不是「两端都有这记手势」。
// ⚠ 名单里 `lineBoundsAt` / `leadingIndent` / `lineClamp` / `outdentWidth` 是模块私有
// helper —— 本闸按函数名从真源码里切片再拼,被切的那几个用到谁,谁就得一起切进来
// (缺了当场 ReferenceError,fail-closed)。
const CK_FNS = [
  "parseChecklistLine",
  "toggleChecklistLine",
  "lineBoundsAt",
  "leadingIndent",
  "lineClamp",
  "continueChecklistOnNewline",
  "toggleChecklistMarker",
  "outdentWidth",
  "indentChecklistLines",
  "minimalEditRange",
];
const CK_CONSTS = ["LINE_RE", "MARK", "INDENT"];
const CK_DESKTOP = { label: "桌面", entry: "src/checklist.ts", consts: CK_CONSTS, fns: CK_FNS };
const CK_ANDROID = { label: "安卓", entry: "android/src/checklist.ts", consts: CK_CONSTS, fns: CK_FNS };

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
// autoTagTopicIds:「筛着标签建条目」自动挂哪几枚(两端同一份判据;用户 2026-08-31
// 拍板「相关的标签都打上」)。⛔ 承重的两格 = 多选要**全给**(此前只给单选那一枚)、
// "none" 必须剔掉(它不是标签,挂不上)。
const AUTOTAG_CASES = [
  ["单选具体标签→就它一枚", ["t_work"], "t_work"],
  ["多选→全给(并集里每一枚都算「相关」)", ["t_work", "t_life"], "t_work|t_life"],
  ["「无标签」不是标签,剔掉", ["none"], ""],
  ["混选:剔掉 none、留下具体标签", ["none", "t_work"], "t_work"],
  ["空选集→没什么可挂", [], ""],
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
// 正文待办清单:认行。⭐ **承重那格 = 裸 `- 文字` 不是待办项**(用户 2026-09-01 拍板:
// 认了它,用户就再也写不出一个不带勾的普通列表)。其余用例钉的是「行首那个标记的边界
// 到底划在哪」—— 边界宽一寸,普通正文就会莫名其妙长出方框。
// [描述, 输入行, 期望 "缩进|勾没勾|剩下那截" 或 "null"]
const PARSE_CASES = [
  ["标准未勾", "- [ ] 买菜", "|off| 买菜"],
  ["标准已勾(小写 x)", "- [x] 买菜", "|on| 买菜"],
  ["大写 X 也收(markdown 两种写法都有)", "- [X] 买菜", "|on| 买菜"],
  ["⭐ 裸 `- 文字` 不是待办项(否则普通列表就写不出来了)", "- 买菜", "null"],
  ["空方框后面没内容也算(空项)", "- [ ]", "|off|"],
  ["方括号后必须是空白或行尾", "- [x]买菜", "null"],
  ["`-` 与 `[` 之间恰一个空格", "-[ ] 买菜", "null"],
  ["两个空格不算", "-  [ ] 买菜", "null"],
  ["星号列表不算(只认 `-`)", "* [ ] 买菜", "null"],
  ["缩进(空格)原样留下", "  - [ ] 买菜", "  |off| 买菜"],
  ["缩进(tab)原样留下", "\t- [x] 买菜", "\t|on| 买菜"],
  ["非行首不算 —— 整行必须从标记起头", "先说一句 - [ ] 买菜", "null"],
  ["方框里只许一个字符", "- [xx] 买菜", "null"],
  ["方框里别的字符不算", "- [o] 买菜", "null"],
  ["剩下那截原样(含多余空格,与行内长得像标记的文字)", "- [ ]   买 - [x] 菜", "|off|   买 - [x] 菜"],
  // 正则里的 `.` 不吃行终止符(\r 也是),故 CRLF 正文切出来的行认不出 —— **就让它认不
  // 出**:textarea 的 value 恒被规范化成 LF,真出现 \r 是异常来路,当普通文字画是安全的
  // 那一边(不会勾错行)。这一格钉的是「降级方向」,不是「支持 CRLF」。
  ["CRLF 切出来的行不认(降级成普通文字,不勾错)", "- [ ] 买菜\r", "null"],
];
// 正文待办清单:翻标记。⭐ 承重两格 = **只动方括号里那一个字符**(正文是用户的话,勾选
// 不是编辑它的借口)与**认不出就放弃**(⛔ 别就近找一行勾 —— 勾错行是静默改错数据)。
// [描述, 正文, 行号, 期望新正文 或 "null"]
const TOGGLE_CASES = [
  ["翻第一行:未勾 → 勾", "- [ ] a\n- [x] b", 0, "- [x] a\n- [x] b"],
  ["翻第二行:勾 → 未勾", "- [ ] a\n- [x] b", 1, "- [ ] a\n- [ ] b"],
  ["⭐ 只动那一行方括号里那一个字符,别的字节一个不碰", "抬头\n  - [X] 事 · 见图1\n落款", 1, "抬头\n  - [ ] 事 · 见图1\n落款"],
  ["⭐ 那一行不是待办项 → null(⛔ 别就近找一行)", "普通一行\n- [ ] a", 0, "null"],
  ["行号越界 → null", "- [ ] a", 5, "null"],
  ["负行号 → null", "- [ ] a", -1, "null"],
  ["单行正文", "- [ ] 只有一项", 0, "- [x] 只有一项"],
  // ⚠ 这一格是阴性对照逼出来的:此前那几格的 rest 都没有尾部空白 ⇒ 在翻标记里顺手
  // `trimEnd()` **一格都不会红**。正文是用户的话,连他多打的那两个空格都不许动。
  ["⭐ 剩下那截连尾部空白都原样(⛔ 别顺手 trim)", "- [ ] 待办  ", 0, "- [x] 待办  "],
];
function serParse(r) {
  return r === null ? "null" : `${r.indent}|${r.checked ? "on" : "off"}|${r.rest}`;
}
// ⭐ **记法:正文里用 `|` 标光标**(两枚 = 选区两端),期望也用同一记法写回来。
// ⚠ 这不是花样 —— 第一版用的是「正文 + 光标下标」,而下标里的中文字符我数错了八格,
// 于是「期望」变成了拿实得凑出来的数(= 判据自指)。标记法让人**看得见**光标在哪,
// 期望是照着语义写的,与被测代码无关。
function cur(s) {
  const a = s.indexOf("|");
  if (a === -1) throw new Error(`用例没标光标:${JSON.stringify(s)}`);
  const rest = s.slice(0, a) + s.slice(a + 1);
  const b = rest.indexOf("|");
  return b === -1 ? { value: rest, a, b: a } : { value: rest.slice(0, b) + rest.slice(b + 1), a, b };
}
function serEdit(r) {
  const s = r.value;
  return r.selStart === r.selEnd
    ? `${s.slice(0, r.selStart)}|${s.slice(r.selStart)}`
    : `${s.slice(0, r.selStart)}|${s.slice(r.selStart, r.selEnd)}|${s.slice(r.selEnd)}`;
}
// 正文待办清单:续行(562)。⭐ 承重三格 = **不是待办项就返回 null**(放行默认换行,
// ⛔ 别把普通正文也接管掉)、**空项上再按一次退出清单**(不插新行,和各家编辑器一个手势)、
// **带出的缩进与当前行一致**。
// [描述, 带 `|` 的正文, 期望(带 `|` 的新正文)或 "null"]
const NEWLINE_CASES = [
  ["待办项行尾按下 → 带出下一项", "- [ ] 买菜|", "- [ ] 买菜\n- [ ] |"],
  ["⭐ 普通正文 → null(放行默认换行)", "随手记一笔|", "null"],
  ["⭐ 裸 `- 文字` 也 → null(它不是待办项)", "- 买菜|", "null"],
  ["已勾的项照样续出**未勾**的下一项", "- [x] 买菜|", "- [x] 买菜\n- [ ] |"],
  ["缩进跟着走(空格)", "  - [ ] 买菜|", "  - [ ] 买菜\n  - [ ] |"],
  ["缩进跟着走(tab)", "\t- [ ] 买菜|", "\t- [ ] 买菜\n\t- [ ] |"],
  ["⭐ 空项上再按一次 = 退出清单:整行抹平、不插新行", "- [ ] 买菜\n- [ ] |", "- [ ] 买菜\n|"],
  ["⭐ 退出清单连缩进一起抹(⛔ 别留一行空白噪音)", "  - [ ] |", "|"],
  ["只打了标记、后面一个空格都没有,也算空项", "- [ ]|", "|"],
  ["行中间按下:后半截被推到新项里", "- [ ] 买菜|和肉", "- [ ] 买菜\n- [ ] |和肉"],
  ["⭐ 光标还在标记里 → null(⛔ 别把标记劈成两半)", "- [| ] 买菜", "null"],
  ["光标恰在正文第一个字之前 = 已过标记,接管", "- [ ] |买菜", "- [ ] \n- [ ] |买菜"],
  ["⭐ 选中了一段再按 → null(那一记的语义是替换,不是续行)", "- [ ] |买|菜", "null"],
  ["多行正文里认的是**光标那一行**", "抬头\n- [ ] 买菜|\n落款", "抬头\n- [ ] 买菜\n- [ ] |\n落款"],
  ["光标在第一行行首(pos=0)不越界", "|\n- [ ] 买菜", "null"],
];
// 正文待办清单:起一条 / 摘掉(562,桌面 Ctrl+L、安卓「＋ 待办」)。⭐ 承重三格 =
// **方向看整块**(有一行还不是就整块都加)、**多行里的空行原样留着**(别长出空待办项)、
// **摘标记只去掉标记与它后面那一个空白**(别的原文一字不动)。
// [描述, 带 `|` 的正文, 期望(带 `|` 的新正文)]
const MARKER_CASES = [
  ["空框里起一条", "|", "- [ ] |"],
  ["一行普通文字变成待办项(光标随之右移)", "买菜|", "- [ ] 买菜|"],
  ["再按一次摘掉", "- [ ] 买菜|", "买菜|"],
  ["摘掉已勾的那种", "- [x] 买菜|", "买菜|"],
  ["⭐ 摘标记只去掉标记与它后面那**一个**空白(多打的空格留着)", "- [ ]   买菜|", "  买菜|"],
  ["缩进原样保留在标记之前", "  买菜|", "  - [ ] 买菜|"],
  ["⭐ 空行上按也照加(那正是「我要在这儿起一条」)", "抬头\n|\n落款", "抬头\n- [ ] |\n落款"],
  ["光标在标记里时摘掉不许跑到行外", "- |[ ] 买菜", "|买菜"],
  ["光标在标记里时摘掉不许跑到**上一行**去", "抬头\n- |[ ] 买菜", "抬头\n|买菜"],
  ["⭐ 光标在最前面、而首字符正是换行(lineBoundsAt 的 pos=0 边角)", "|\n买菜", "- [ ] |\n买菜"],
  ["多行:三行全变待办项,选区盖住整块", "|买菜\n做饭\n洗碗|", "|- [ ] 买菜\n- [ ] 做饭\n- [ ] 洗碗|"],
  ["⭐ 多行方向看整块:混排时**整块都加**(⛔ 别只看第一行)", "|- [ ] 买菜\n做饭|", "|- [ ] 买菜\n- [ ] 做饭|"],
  ["多行全是待办项才整块摘", "|- [ ] 买菜\n- [x] 做饭|", "|买菜\n做饭|"],
  ["⭐ 多行里的空行原样留着(⛔ 别长出空待办项)", "|买菜\n\n洗碗|", "|- [ ] 买菜\n\n- [ ] 洗碗|"],
  ["选区在一行之内:选中的那几个字加完标记后**仍被选中**(选区跟着文字走)", "抬头\n|买菜|\n落款", "抬头\n- [ ] |买菜|\n落款"],
  ["选区两端在同一行内(行中间那一段)", "买|菜做|饭", "- [ ] 买|菜做|饭"],
];
// 正文待办清单:缩进 / 反缩进(600,桌面 Tab / Shift+Tab;安卓软键盘上没有这一记,
// 但纯逻辑仍两端逐字对应,故照样两端同压)。⭐ 承重三格 = **不涉及待办项就返回 null**
// (⛔ 别吃掉 Tab —— 它是键盘用户离开输入框的唯一通路)、**已经顶格也返回 null**
// (一个字都不会变的那一记同样还给焦点)、**多行里的空行原样留着**(别加出看不见的噪音)。
// [描述, 带 `|` 的正文, 推进=true / 退回=false, 期望(带 `|` 的新正文)或 "null"]
const INDENT_CASES = [
  ["⭐ 普通正文 → null(⛔ 别吃掉 Tab,那是键盘用户走出输入框的唯一通路)", "随手记一笔|", true, "null"],
  ["⭐ 裸 `- 文字` 也 → null(它不是待办项)", "- 买菜|", true, "null"],
  ["待办项推进一级 = 行首两个空格", "- [ ] 买菜|", true, "  - [ ] 买菜|"],
  ["已勾的项照样推得动", "- [x] 买菜|", true, "  - [x] 买菜|"],
  ["再推一级就是四个", "  - [ ] 买菜|", true, "    - [ ] 买菜|"],
  ["Shift+Tab 退回一级", "  - [ ] 买菜|", false, "- [ ] 买菜|"],
  ["⭐ 已经顶格 → null(一个字都不会变,那一记还给焦点)", "- [ ] 买菜|", false, "null"],
  ["⭐ 只缩了一个空格就只削那一个(⛔ 别越过实有的缩进)", " - [ ] 买菜|", false, "- [ ] 买菜|"],
  ["制表符那种缩进削一个字符(画的那半也是按字符数算的)", "\t- [ ] 买菜|", false, "- [ ] 买菜|"],
  ["光标在行首:推进后落在文字之前", "|- [ ] 买菜", true, "  |- [ ] 买菜"],
  ["退回时光标不许甩出这一行(光标停在缩进里那种)", "  |- [ ] 买菜", false, "|- [ ] 买菜"],
  // ⚠ 上面那格**量不到**夹取的下限到底是本行行首还是 0 —— 待办项就在第一行时两者恒等,
  // 把 `Math.max(ls, …)` 砍成 `Math.max(0, …)` 一格都不会红(阴性对照当场逮到)。要让它
  // 可观测,待办项得**不在第一行**、且光标停在正要被削掉的那截缩进里。同 `起一条` 那族的
  // 「不许跑到上一行」那格,判据一致。
  ["⭐ 退回时光标不许甩到**上一行**去(待办项不在首行、光标停在正被削掉的缩进里)", "抬头\n | - [ ] 买菜", false, "抬头\n|- [ ] 买菜"],
  ["选区在一行之内:选中的那几个字推进后**仍被选中**", "- [ ] |买菜|", true, "  - [ ] |买菜|"],
  ["多行正文里动的是**光标那一行**", "抬头\n- [ ] 买菜|\n落款", true, "抬头\n  - [ ] 买菜|\n落款"],
  ["多行:整块一起动,选区盖住改写后的整块", "|- [ ] 买菜\n- [ ] 做饭|", true, "|  - [ ] 买菜\n  - [ ] 做饭|"],
  ["⭐ 多行里的空行原样留着(⛔ 别给空行加两个空格 —— 正文里一行看不见的噪音)", "|- [ ] 买菜\n\n- [ ] 洗碗|", true, "|  - [ ] 买菜\n\n  - [ ] 洗碗|"],
  ["⭐ 混排:只要有一行是待办项,整块就都动", "|- [ ] 买菜\n随手一句|", true, "|  - [ ] 买菜\n  随手一句|"],
  ["⭐ 一行待办项都不涉及 → null(整块普通正文照旧移焦点)", "|买菜\n做饭|", true, "null"],
  ["多行退回:削得动的削、顶格那行不动(⛔ 不是整块弃权)", "|  - [ ] 买菜\n- [ ] 做饭|", false, "|- [ ] 买菜\n- [ ] 做饭|"],
  ["⭐ 多行全顶格 → null", "|- [ ] 买菜\n- [ ] 做饭|", false, "null"],
  ["光标在最前面、而首字符正是换行(lineBoundsAt 的 pos=0 边角)", "|\n- [ ] 买菜", true, "null"],
];
// 最小改写区间(562):接线层拿它把「整份新正文」翻译成 execCommand 那一笔,撤销栈才留得住。
// [描述, 老文本, 新文本, 期望 "from␟to␟插入的文字"]
const RANGE_CASES = [
  ["纯插入", "ab", "aXb", "1␟1␟X"],
  ["纯删除", "aXb", "ab", "1␟2␟"],
  ["一字不变 → 空区间(什么都不用做)", "ab", "ab", "2␟2␟"],
  ["整份换掉", "abc", "xyz", "0␟3␟xyz"],
  ["首尾都有共同部分", "- [ ] 买菜", "- [x] 买菜", "3␟4␟x"],
  ["从空串起", "", "- [ ] ", "0␟0␟- [ ] "],
  ["删到空串", "- [ ] ", "", "0␟6␟"],
  ["⭐ 重复字符:前缀吃满后后缀不许再回头吃(区间不可交叉)", "aaa", "aa", "2␟3␟"],
  ["⭐ 重复字符的反向(插入)", "aa", "aaa", "2␟2␟a"],
];
function serRange(r) {
  return `${r.from}␟${r.to}␟${r.text}`;
}

// 标签 pill 行(假 DOM 压真渲染):[描述, allTopics, items, f, 期望序列]
// 记法:label:计数  *=active  °=色点  ▸/▾=折叠箭头  <id=child 挂父  …=hidden
const RENDER_CASES = [
  // ⑤ 499 改口径:去留按**整族**算(族里但凡有一条内容就整族画:父 + ▸ + 全部子,
  // 空的那枚灰显)。旧口径「零计数逐枚滤掉」会让「父有任务、子这阵子空着」的族连折叠
  // 箭头都不出 = 屏上一点层级都看不见(用户实报)。⚠ 这三格是同一条规则的三面,别只改一面。
  ["⑤ 父 0 计数且未选、子有内容 → 父仍在场带 ▸(层级不塌)", [T.work, T.workA], items("B"), F("all", [], ""),
    "所有:1* | 无标签:0 | 工作:0°▸ | 甲方:1<t_work…"],
  ["⑤b 父有内容、子全空 → 父带 ▸,空子仍在场(展开才见)", [T.work, T.workA], items("A"), F("all", [], ""),
    "所有:1* | 无标签:0 | 工作:1°▸ | 甲方:0<t_work…"],
  ["⑤c 整族零内容 → 整族不画(筛选条不是标签总目录)", [T.work, T.workA, T.life], items("C"), F("all", [], ""),
    "所有:1* | 无标签:0 | 生活:1"],
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

console.log("=== 纯逻辑:applyFilter / reconcile* / filterActive / soleTopicFilter / autoTagTopicIds / selectedTopicLabels ===");
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
  for (const [desc, topics, want] of AUTOTAG_CASES) check(`[${end.label}] autoTagTopicIds:${desc}`, m.autoTagTopicIds(F("all", topics, "")).join("|"), want);
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

console.log("\n=== 正文待办清单:parseChecklistLine / toggleChecklistLine(两端同压)===");
const CK_ENDS = [
  { label: CK_DESKTOP.label, mod: await loadEnd(CK_DESKTOP) },
  { label: CK_ANDROID.label, mod: await loadEnd(CK_ANDROID) },
];
for (const end of CK_ENDS) {
  for (const [desc, line, want] of PARSE_CASES) {
    check(`[${end.label}] 认行:${desc}`, serParse(end.mod.parseChecklistLine(line)), want);
  }
  for (const [desc, content, i, want] of TOGGLE_CASES) {
    check(`[${end.label}] 翻标记:${desc}`, String(end.mod.toggleChecklistLine(content, i)), want);
  }
  for (const [desc, input, want] of NEWLINE_CASES) {
    const { value, a, b } = cur(input);
    const r = end.mod.continueChecklistOnNewline(value, a, b);
    check(`[${end.label}] 续行:${desc}`, r === null ? "null" : serEdit(r), want);
  }
  for (const [desc, input, want] of MARKER_CASES) {
    const { value, a, b } = cur(input);
    check(`[${end.label}] 起一条:${desc}`, serEdit(end.mod.toggleChecklistMarker(value, a, b)), want);
  }
  for (const [desc, input, deeper, want] of INDENT_CASES) {
    const { value, a, b } = cur(input);
    const r = end.mod.indentChecklistLines(value, a, b, deeper);
    check(`[${end.label}] ${deeper ? "缩进" : "反缩进"}:${desc}`, r === null ? "null" : serEdit(r), want);
  }
  for (const [desc, before, after, want] of RANGE_CASES) {
    check(`[${end.label}] 改写区间:${desc}`, serRange(end.mod.minimalEditRange(before, after)), want);
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
