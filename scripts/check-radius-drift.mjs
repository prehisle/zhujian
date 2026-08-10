#!/usr/bin/env node
// 圆角漂移门禁(341)。第六道。核**四份**:
//
//   桌面 src/theme.css              —— 令牌表真相源
//   安卓 android/index.html         —— 内联一份
//   官网 site/index.html            —— 内联一份
//   规范 docs/ui-guidelines.md §2.5 —— 文档里那张表(照 340 的形,文档进被核对的范围)
//
// 再加一层前五道都没有的:**用法**。328 核令牌定义、336/337/338 核颜色的用法、339 核
// 写死的颜色、340 核时长常量 —— 而几何一直没人看。本轮之前 `border-radius` 在这四份
// 里散着 **17 种取值**(3/4/5/6/7/8/9/10/11/12/13/14px 全齐),一个令牌都没有。
//
// # 它挡的是什么(立项当天量出的三个真判例,全是「同一件东西两个值」)
//
//  · **朱砂小方块**:桌面 `.view header h1::before` 12px 方块写 `3px`,官网 `.eyebrow::before`
//    9px 与 `.pillar h3::before` 8px 各写 `2px` —— 同一枚记号三处三个值。已收成
//    `--radius-seal: 25%`(半径 = 边长的 1/4,随尺寸走)。
//  · **拖动落点线**:桌面 `.v-board .drop-line` 写 `999px`,安卓 `.drop-line` 写 `2px`。
//    两者渲染其实相同(2px 高的线上 999px 会被等比夹取成 1px),但**没人保证它们同步** ——
//    与 339 那条「同一个语义两端两个值 = 漂移」同型。
//  · **`.slip` 纸片**:桌面 `index.html` 16px,官网 `site/index.html` 18px。与 328 抓到的
//    `--font-serif` 同型:两份从上线第一笔起就没一致过,三年没人发现。
//
// # 两个方向都核
//
//   · 值里出现尺寸字面量而没登记 → 红(漏网)
//   · 登记表里某一条今天一处都没命中 → 红(过期的例外什么都不守)
//   · 规范表里有、令牌表里没有(或反之) → 红
//   · 某个令牌今天一处都没人用 → 红(定义了没人用的阶只是装饰)
//
// # 诚实边界(印在每次输出里,别让它悄悄变大)
//
//   · 只核**值**,不核「谁该用哪一档」——「最近档取胜」是 341 的收敛判据,不是能自动核的契约。
//   · 认 `border-radius` 简写与四个单角长写法(`border-top-right-radius` 等)。⚠ 立项时
//     这里原本写着「只认简写」并配一道禁用长写法的探针,而那道探针当场逮到 `.img-badge`
//     的 `border-top-right-radius: 5px` —— 341 前半程 190 处的人工盘点整个漏了这种写法。
//     地面上真有,就该收进扫描面而不是禁掉。
//   · 扫描面 = `scripts/lib/css-docs.mjs` 算出来的四个文档按文件去重(与前三道同一件东西),
//     故 CSS 之外的圆角(内联 style 属性、TS 里 setProperty)不在其中 —— 今天地面上一处都
//     没有,下面那道探针守着这句话。
//
// 用法:node scripts/check-radius-drift.mjs
// 全对齐 = 退出 0;漂移 / 未登记的字面量 / 过期的登记 / 看不懂的形状 = 非零响亮。
// 发版门禁之一(见 docs/dev-and-testing.md 与 skill zhujian-ops)。

import { readFileSync } from "node:fs";
import { DOCS, sheetsOf, R } from "./lib/css-docs.mjs";

const NL = String.fromCharCode(10);
const DOC = "docs/ui-guidelines.md";

/** 三份令牌表。与 check-theme-drift 的 SOURCES 同名同文件(那道核「三份逐字相同」,这道核「与规范和用法对得上」)。 */
const SOURCES = [
  { name: "桌面", file: "src/theme.css" },
  { name: "安卓", file: "android/index.html" },
  { name: "官网", file: "site/index.html" },
];

/**
 * 不在圆角阶上的值,逐处登记。**一条 = 一个决定**,必须写清楚为什么它不是一档尺寸。
 * 每条都会被反向核对:今天不再命中 = 红。
 *
 * 注:`0` 不在这里 —— 它作为**多角写法里的一个分量**(`var(--radius-lg) var(--radius-lg) 0 0`)
 * 表示「这个角不圆」,是形状不是尺寸,下面按分量放行。整条声明只写一个 `0` 的仍要登记
 * (那是「明确取消宿主的圆角」,是个决定)。
 */
const ALLOW = [
  {
    file: "notebook.html#style",
    selector: ".wc",
    value: "0",
    why: "捕获窗内嵌在主窗里那块承载区,明确取消圆角 —— 它要与窗口边缘齐平,不是一个卡片",
  },
  {
    file: "src/theme.css",
    selector: ".just-born::after",
    value: "inherit",
    why: "「刚落地」的高亮描边是覆在宿主上的一层 ::after,圆角必须**追随宿主** —— 宿主可能是\
灵感卡(md)也可能是时间轴行,写死任何一档都会在另一种宿主上露出直角",
  },
  {
    file: "src/theme.css",
    selector: ".just-located::after",
    value: "inherit",
    why: "同 .just-born::after:「定位到这条」的高亮描边,同一件事的另一个触发",
  },
];

// ---- 解析 ---------------------------------------------------------------------------

/** 取 `:root { … }` 块体(花括号配平);配不平就抛,别猜。 */
function rootBody(text, file) {
  const at = /:root\s*\{/.exec(text);
  if (!at) throw new Error(`${file}:找不到 :root { —— 令牌表没了?`);
  const open = text.indexOf("{", at.index);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`${file}::root 的 { 没有配平的 } —— 解析器看不懂这个形状`);
}

/** 一份文件里的圆角令牌:Map(名 → 值)。 */
function tokensOf(rel) {
  const body = rootBody(readFileSync(R(rel), "utf8"), rel);
  const out = new Map();
  for (const m of body.matchAll(/(--radius-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

/**
 * 取规范 §2.5 那张表:`| \`--令牌\` | 值 | 用途 |`。
 * 认不出的行一律抛(表被改成别的形状时要响亮,不是静静少判几行)。
 */
function docTable() {
  const src = readFileSync(R(DOC), "utf8");
  const at = src.indexOf("### 2.5");
  if (at === -1) throw new Error(`${DOC} 里找不到「### 2.5」—— 章节被改名了?`);
  // 上界取「下一条 --- / 下一个小节 / 下一章」里先到的那个。⚠ 341 同轮修了 340 那只
  // 同形函数:它原本只找 `---`,而 §2.5 一插进去就把它读串了 —— 别依赖一条碰巧在那儿
  // 的分隔线当章节边界。
  const ends = [NL + "---", NL + "### ", NL + "## "].map((t) => src.indexOf(t, at + 1)).filter((i) => i !== -1);
  const end = ends.length ? Math.min(...ends) : -1;
  const block = src.slice(at, end === -1 ? src.length : end);
  const rows = block.split(NL).filter((l) => l.trim().startsWith("|"));
  if (rows.length < 3) throw new Error(`${DOC} §2.5 的表少于 3 行 —— 表没了?`);
  const out = new Map();
  for (const row of rows.slice(2)) {
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) throw new Error(`${DOC} §2.5 表里这一行认不出形状:${row}`);
    const m = /^`(--radius-[a-z0-9-]+)`$/.exec(cells[0]);
    if (!m) throw new Error(`${DOC} §2.5 表里第一格不是 \`--radius-*\`:${cells[0]}`);
    if (!/^[\w.%]+$/.test(cells[1])) throw new Error(`${DOC} §2.5「${m[1]}」的值格认不出:${cells[1]}`);
    out.set(m[1], cells[1]);
  }
  return out;
}

/**
 * 从一份 CSS 文本里摘出全部 border-radius 声明:{ sel, value }。
 *
 * 两件先剥掉再扫:`/* … *\/` 块注释(**换行原样留着**,否则下面的选择器跟踪会错位)。
 * 不剥的话注释掉的圆角照抓、还会挂到上一个选择器名下 —— 自检那一格是这么发现的。
 *
 * ⚠ 已知边界(自检钉着,不是猜的):选择器按「最近一个带 { 的行」认,故**跨行写的
 * 选择器组只报最后一行**(`.c,` 换行 `.d {` → 报 `.d`)。今天四份 CSS 里带圆角的
 * 选择器组都写在一行内,故不影响;真出现了,登记表那一格要按 `.d` 写。
 */
function radiiOf(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const rows = [];
  let sel = "";
  for (const L of clean.split(NL)) {
    if (L.includes("{")) sel = L.split("{")[0].trim().replace(/\s+/g, " ");
    for (const m of L.matchAll(/\b(border(?:-(?:top|bottom)-(?:left|right))?-radius)\s*:\s*([^;]+);/g))
      rows.push({ sel, prop: m[1], value: m[2].trim() });
  }
  return rows;
}

// ---- 抓取器自检 ---------------------------------------------------------------------
// 照 340 / 339 的做法:一段不随仓库变的样本,每种该抓的写法与每种该跳过的形状各一处,
// 抓到的**规格串**必须恰好等于期望。少抓 = 少判 = 安静的绿。
function selfCheck() {
  const sample = [
    ".a { border-radius: var(--radius-md); }",
    ".b { padding: 4px; border-radius: 10px; color: red; }", // 同一行里夹着别的声明
    ".c,",
    ".d { border-radius: 0 var(--radius-xs) var(--radius-xs) 0; }", // 多角 + 跨行选择器组
    "/* 注释掉的不算:border-radius: 99px; */",
    "/* 跨行的注释也要剥干净,",
    "   border-radius: 98px; */",
    ".e { border-top-left-radius: 3px; }", // 长写法(单角):也在扫描面内
    ".f { border-radius: 50%; }",
  ].join(NL);
  const got = radiiOf(sample).map((r) => `${r.sel}=${r.value}`).join(" | ");
  // ⚠ 这四条是**实测出来的**行为,不是我写下来的期望:第一版把跨行选择器组写成
  // 「.c, .d」、把注释那条写成「不抓」,自检当场把两处都判错了(339 那条「我先分析
  // 后实测、分析错了」同型)。跨行选择器组只报最后一行 —— 已记在 radiiOf 的边界里。
  const want = [
    ".a=var(--radius-md)",
    ".b=10px",
    ".d=0 var(--radius-xs) var(--radius-xs) 0",
    ".e=3px",
    ".f=50%",
  ].join(" | ");
  if (got !== want) throw new Error(`抓取器自检不过:${NL}  抓到 [${got}]${NL}  期望 [${want}]`);
  // 阴性对照:剥注释那一步真去掉的话,上面那两条注释里的 99px / 98px 会被抓进来。
  const naive = [];
  let s2 = "";
  for (const L of sample.split(NL)) {
    if (L.includes("{")) s2 = L.split("{")[0].trim().replace(/\s+/g, " ");
    for (const m of L.matchAll(/\bborder(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;]+);/g))
      naive.push(`${s2}=${m[1].trim()}`);
  }
  if (naive.length !== 7) {
    throw new Error(`自检的阴性对照失灵:不剥注释该抓到 7 条,实际 ${naive.length} 条 —— 样本被改动了?`);
  }
}

// ---- 跑 -----------------------------------------------------------------------------

let bad = 0;
const say = (s) => { console.log(s); bad++; };

selfCheck();

// ① 规范表 ↔ 三份令牌表
const doc = docTable();
const tokens = new Map(SOURCES.map((s) => [s.name, tokensOf(s.file)]));
for (const [name, want] of doc) {
  for (const s of SOURCES) {
    const got = tokens.get(s.name).get(name);
    if (got === undefined) say(`✗ ${s.name} ${s.file} 缺令牌 ${name}(规范 §2.5 有这一行)`);
    else if (got !== want) say(`✗ ${name} 漂移:规范 §2.5 写 ${want},${s.name} 写 ${got}`);
  }
}
for (const s of SOURCES) {
  for (const name of tokens.get(s.name).keys()) {
    if (!doc.has(name)) say(`✗ ${s.name} ${s.file} 定义了 ${name},而规范 §2.5 表里没有这一行`);
  }
}

// ② 用法:扫描面按文件去重(与前三道同一件东西)
const seen = new Map();
for (const d of DOCS) for (const sh of sheetsOf(d)) if (!seen.has(sh.file)) seen.set(sh.file, sh.text);

const hitAllow = new Set();
const usedToken = new Set();
let decls = 0;
for (const [file, text] of seen) {
  for (const { sel, prop, value } of radiiOf(text)) {
    decls++;
    const parts = value.split(/\s+/);
    // `0` 只在**多角写法的某一个分量**上免登记(「这个角不圆」是形状不是尺寸)。
    // 整条声明就写一个 `0` 的是个决定(明确取消宿主的圆角),照样要签字。
    const freeZero = parts.length > 1;
    const bare = parts.filter((p) => !/^var\(--radius-[a-z0-9-]+\)$/.test(p) && !(freeZero && p === "0"));
    for (const p of parts) {
      const m = /^var\((--radius-[a-z0-9-]+)\)$/.exec(p);
      if (!m) continue;
      if (!doc.has(m[1])) say(`✗ ${file}「${sel}」的 ${prop} 用了规范 §2.5 表里没有的令牌 ${m[1]}`);
      usedToken.add(m[1]);
    }
    if (!bare.length) continue;
    const i = ALLOW.findIndex((a) => file.startsWith(a.file) && a.selector === sel && a.value === value);
    if (i === -1) {
      say(`✗ ${file}:${sel}  ${prop}: ${value}  —— 没走令牌,也没在登记表里`);
    } else hitAllow.add(i);
  }
}
ALLOW.forEach((a, i) => {
  if (!hitAllow.has(i)) say(`✗ 登记表第 ${i + 1} 条一处都没命中(${a.file} ${a.selector} = ${a.value})—— 过期的例外什么都不守`);
});
for (const name of doc.keys()) {
  if (!usedToken.has(name)) say(`✗ ${name} 在规范 §2.5 表里有一行,而扫描面里一处都没人用 —— 定义了没人用的阶只是装饰`);
}

// ③ 探针:扫描面之外别再长出圆角来。
//    ⚠ 立项时这里还有一道「不许出现长写法」的探针 —— 它当场逮到 `.img-badge` 的
//    `border-top-right-radius: 5px`(「图N」角标只圆右上角),而 341 前半程 190 处的
//    人工盘点**整个漏了这种写法**。既然地面上真有,正解是把它收进扫描面(radiiOf 现在
//    认四个单角写法)而不是禁掉它,于是那道探针退役。留下的只有内联 style 这一条。
for (const rel of ["index.html", "notebook.html", "android/index.html", "site/index.html"]) {
  const src = readFileSync(R(rel), "utf8");
  for (const m of src.matchAll(/style\s*=\s*"[^"]*border-radius/g)) {
    say(`✗ ${rel} 有行内 style 写圆角(${m[0].slice(0, 40)}…)—— 不在扫描面内,先决定怎么核它`);
  }
}

console.log(
  `${NL}圆角门禁:${decls} 处 border-radius,` +
    `${doc.size} 个令牌(三份逐字对齐、与规范 §2.5 三方对账),登记的例外 ${ALLOW.length} 条。`,
);
console.log("⚠ 诚实边界:只核值不核「谁该用哪一档」;overflow 有没有跟上圆角容器,这道闸看不见。");
process.exit(bad ? 1 : 0);
