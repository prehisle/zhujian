#!/usr/bin/env node
// 字号漂移门禁(342)。第七道。照 341 的形核**四份**:
//
//   桌面 src/theme.css              —— 令牌表真相源
//   安卓 android/index.html         —— 内联一份
//   官网 site/index.html            —— 内联一份
//   规范 docs/ui-guidelines.md §2.2 —— 文档里那张表(340 起文档进被核对的范围)
//
// 再加 341 那一层:**用法**。CSS 里的字号不许再出现尺寸字面量,每一处要么走令牌、
// 要么在下面的登记表里签字。本轮之前字号在这四份里散着 **29 种取值**、一个令牌都没有,
// 其中 12.5 / 11.5 / 14.5 / 10.5 / 9.5 / 16.5 / 13.5px 这类半像素占 63 处。
//
// # 它比前六道多守的一件事:**最小档就是规范本身**
//
// §2.2 第一条「信息性文字最小 12px」此前是文档里的一句话,没有任何闸看着它。这道门禁
// 把它做成了**阶的形状**:阶从 12px 起、阶下无档,任何小于 12px 的字号必须在 ALLOW 里
// 逐处签字说明「它是纯装饰」。于是那条规范不再需要人去记 —— 违反它的唯一方式是往
// ALLOW 里写一行假话,而假话是留了名字的。
//
// 判据 =「要读的」还是「要看的」:词、数字、时间戳、键名都是要读的;`▸▾ × ✓` 这类
// 字形当图标、只承载 <svg> 的按钮、::before 的记号是要看的。342 按这条判了 63 处,
// 50 处抬到 12px、12 处签字留下。立项当天逮到的原型:`.color-swatch.none` 在一枚 17px
// 圆钮里用 --ink-faint 写 **9px 的「无」**(正是审计 #25 那句),而它藏在 `font:` 简写里。
//
// # 两个方向都核
//
//   · 值里出现尺寸字面量而没登记 → 红(漏网)
//   · 登记表里某一条今天一处都没命中 → 红(过期的例外什么都不守)
//   · 登记表里出现 ≥12px 的字面量 → 红(那是阶该管的,不许拿登记表绕过收敛)
//   · 令牌表里出现小于 12px 的档 → 红(§2.2 第一条被从令牌那头掏空)
//   · 规范表里有、令牌表里没有(或反之) → 红
//   · 某个令牌今天一处都没人用 → 红(定义了没人用的阶只是装饰)
//
// # 抓取器认哪几种写法(每一种都是踩出来的,别照「常见写法」想当然)
//
//   ① `font-size: 13px`
//   ② `font` 简写里的字号 —— **341 那条教训在本轮兑现了三次**:
//        `font: 12px/1.5 var(--font-sans)`   带行高
//        `font: 14px var(--font-serif)`      不带行高
//        `font: 600 15px/1.4 var(--font-sans)`  **字号前面还能有字重**
//      ⚠ 最后这种是本轮的改写器**栽在自己的对账上**才露出来的:改写器假设「px 打头」,
//      而对账**抄了同一个假设**,于是报了「零漏网」。自检里为此各钉一条。
//   ③ 认不出字号的 `font:` 一律抛(除 CSS 全局关键字与系统字体关键字)—— 宁可当场响,
//      不许静静跳过一条看不懂的声明。
//
// # 诚实边界(印在每次输出里,别让它悄悄变大)
//
//   · 只核**值**,不核「谁该用哪一档」——档名是提示不是契约(同 §2.5)。
//   · §2.2 第二条「小于 14px 禁止与低对比色叠加」**这道闸看不见** —— 343 起它由
//     `check-contrast.mjs` 守着(那道门禁认字号了,小字一档的底线抬到 5.0:1)。这两道闸
//     分工不同:这一道管「值落不落在阶上」,那一道管「这个字号配这个颜色行不行」。
//   · 行高与字距不在扫描面内。
//   · 扫描面 = `scripts/lib/css-docs.mjs` 算出来的四个文档按文件去重(与前四道同一件
//     东西),故 CSS 之外的字号(内联 style 属性、TS 里 setProperty)不在其中 —— 今天
//     地面上一处都没有,下面那道探针守着这句话。
//     ⚠ 安卓的界面字号四档(251)走 WebView 的 textZoom、是**基准上的乘数**,不产生
//     任何 CSS 声明,故不在也不该在这道闸的扫描面内。
//
// 用法:node scripts/check-fs-drift.mjs
// 全对齐 = 退出 0;漂移 / 未登记的字面量 / 过期的登记 / 看不懂的形状 = 非零响亮。
// 发版门禁之一(见 docs/dev-and-testing.md 与 skill zhujian-ops)。

import { readFileSync } from "node:fs";
import { DOCS, sheetsOf, R } from "./lib/css-docs.mjs";

const NL = String.fromCharCode(10);
const DOC = "docs/ui-guidelines.md";

/** 信息性文字的底线。它同时是阶的最小档 —— 见头部注释。 */
const FLOOR = 12;

/** 三份令牌表。与 check-theme-drift 的 SOURCES 同名同文件。 */
const SOURCES = [
  { name: "桌面", file: "src/theme.css" },
  { name: "安卓", file: "android/index.html" },
  { name: "官网", file: "site/index.html" },
];

/**
 * 不在字号阶上的值,逐处登记。**一条 = 一个决定**,必须写清楚它为什么不落在阶上。
 * 每条都会被反向核对:今天不再命中 = 红。
 *
 * 两族:
 *   ① 小于 12px 的**纯装饰**(§2.2 第一条只放行这一种)。判据见头部注释。
 *   ② 本来就不是固定尺寸的**形状**(流体字号、相对宿主的字号)。
 */
const ALLOW = [
  // ---- ① 小于 12px:纯装饰 ----
  { file: "src/board.css", selector: ".v-board .tl-date::before", value: "8px", why: "content:\"◆ \" 朱砂菱形记号,与 341 收成 --radius-seal 的是同一族记号,不承载文字" },
  { file: "src/filter-bar.css", selector: ".tf-pill.child::before", value: "11px", why: "content:\"↳\" 层级指示字形,当图标用" },
  { file: "android/index.html", selector: ".fpill.child::before", value: "11px", why: "同上,安卓那份" },
  { file: "android/index.html", selector: ".fcaret", value: "11px", why: "展开/收起箭头字形" },
  { file: "notebook.html", selector: ".space-caret", value: "9px", why: "▾ 空间下拉箭头" },
  { file: "src/filter-bar.css", selector: ".tf-caret", value: "9px", why: "▸/▾ 过滤条箭头" },
  { file: "src/topics.css", selector: ".v-topics .topic-caret", value: "10px", why: "▸ 标签展开箭头" },
  { file: "src/topics.css", selector: ".v-topics .topic-kids-toggle .kt-chev", value: "9px", why: "▸/▾ 子标签折叠箭头" },
  { file: "src/inbox.css", selector: ".v-inbox .tag-x", value: "9px", why: "× 标签删除字形" },
  { file: "src/tasktime.css", selector: ".task-meta .chip-x", value: "10px", why: "× chip 删除字形" },
  { file: "notebook.html", selector: ".wc", value: "10px", why: "窗口控件按钮,内容是 <svg> 没有文字 —— 这里的字号对渲染不产生任何影响" },

  // ---- ② 不是固定尺寸的形状 ----
  { file: "site/index.html", selector: ".hero h1", value: "clamp(40px, 6.6vw, 68px)", why: "官网首屏大标题:随视口流动的字号,不是阶上的一档。下界 40px 已高过阶顶,收进阶只会让它在窄屏上过大" },
  { file: "site/index.html", selector: ".section-title", value: "clamp(26px, 4.2vw, 38px)", why: "同上,章节标题" },
  { file: "site/index.html", selector: ".ethos blockquote", value: "clamp(21px, 2.6vw, 27px)", why: "同上,引言。⚠ 下界 21px 落在阶的 20 与 24 之间 —— 流体字号的端点不受阶约束,这是有意的" },
  { file: "src/item-images.css", selector: ".img-ref", value: "0.86em", why: "正文里的图引用记号,**相对宿主**缩一档 —— 宿主可能是 13px 的时间轴行也可能是 14px 的正文,写死任何一档都会在另一种宿主里失配(与 341 那条 `border-radius: inherit` 同型)" },
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

/** 一份文件里的字号令牌:Map(名 → 值)。 */
function tokensOf(rel) {
  const body = rootBody(readFileSync(R(rel), "utf8"), rel);
  const out = new Map();
  for (const m of body.matchAll(/(--fs-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

/**
 * 取规范 §2.2 那张表:`| \`--令牌\` | 值 | 用途 |`。
 * 认不出的行一律抛(表被改成别的形状时要响亮,不是静静少判几行)。
 */
function docTable() {
  const src = readFileSync(R(DOC), "utf8");
  const at = src.indexOf("### 2.2");
  if (at === -1) throw new Error(`${DOC} 里找不到「### 2.2」—— 章节被改名了?`);
  // 上界取「下一条 --- / 下一个小节 / 下一章」里先到的那个(341 同轮修 340 那只同形函数
  // 时定的形:别依赖一条碰巧在那儿的分隔线当章节边界)。
  const ends = [NL + "---", NL + "### ", NL + "## "].map((t) => src.indexOf(t, at + 1)).filter((i) => i !== -1);
  const end = ends.length ? Math.min(...ends) : -1;
  const block = src.slice(at, end === -1 ? src.length : end);
  const rows = block.split(NL).filter((l) => l.trim().startsWith("|"));
  if (rows.length < 3) throw new Error(`${DOC} §2.2 的表少于 3 行 —— 表没了?`);
  const out = new Map();
  for (const row of rows.slice(2)) {
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) throw new Error(`${DOC} §2.2 表里这一行认不出形状:${row}`);
    const m = /^`(--fs-[a-z0-9-]+)`$/.exec(cells[0]);
    if (!m) throw new Error(`${DOC} §2.2 表里第一格不是 \`--fs-*\`:${cells[0]}`);
    if (!/^\d+(?:\.\d+)?px$/.test(cells[1])) throw new Error(`${DOC} §2.2「${m[1]}」的值格认不出:${cells[1]}`);
    out.set(m[1], cells[1]);
  }
  return out;
}

/** `font` 简写里,不带字号的合法整值(认不出的一律抛,故这张表要显式)。 */
const FONT_KEYWORDS = new Set([
  "inherit", "initial", "unset", "revert", "revert-layer",
  "caption", "icon", "menu", "message-box", "small-caption", "status-bar",
]);

/**
 * 从一份 CSS 文本里摘出全部**字号**声明:{ sel, prop, value }。
 * `value` 是字号那一格(`13px` / `var(--fs-13)`),不是整条简写。
 *
 * 两件先剥掉再扫:`/* … *\/` 块注释(**换行原样留着**,否则下面的选择器跟踪会错位)。
 *
 * ⚠ 已知边界(与 341 的 radiiOf 同一条,自检钉着):选择器按「最近一个带 { 的行」认,
 * 故**跨行写的选择器组只报最后一行**(`.c,` 换行 `.d {` → 报 `.d`)。
 */
function sizesOf(text, file = "?") {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const rows = [];
  let sel = "";
  for (const L of clean.split(NL)) {
    if (L.includes("{")) sel = L.split("{")[0].trim().replace(/\s+/g, " ");
    for (const m of L.matchAll(/\bfont-size\s*:\s*([^;}]+)[;}]/g)) {
      rows.push({ sel, prop: "font-size", value: m[1].trim() });
    }
    for (const m of L.matchAll(/\bfont\s*:\s*([^;}]+)[;}]/g)) {
      const val = m[1].trim();
      // 字号前面可以有 style / variant / weight / stretch(`600`、`italic`、`condensed`…),
      // 故**不假设 px 打头**;逐个成分找第一个「是字号」的那格。
      const size = val.split(/\s+/).find((t) => /^(?:\d+(?:\.\d+)?px|var\(--fs-[a-z0-9-]+\))(?:\/\S*)?$/.test(t));
      if (size) {
        rows.push({ sel, prop: "font", value: size.split("/")[0] });
        continue;
      }
      if (FONT_KEYWORDS.has(val)) continue; // 整值关键字,不带字号
      throw new Error(
        `${file}「${sel}」的 font 简写里认不出字号:「${val}」—— 这只抓取器不猜。` +
          `${NL}  多半是又冒出一种写法(本轮已经栽过三次:带行高 / 不带行高 / 字号前面有字重),` +
          `先教它认,别让它静静跳过。`,
      );
    }
  }
  return rows;
}

// ---- 抓取器自检 ---------------------------------------------------------------------
// 照 341 / 340 / 339 的做法:一段不随仓库变的样本,每种该抓的写法与每种该跳过的形状各
// 一处,抓到的**规格串**必须恰好等于期望。少抓 = 少判 = 安静的绿。
function selfCheck() {
  const sample = [
    ".a { font-size: var(--fs-14); }",
    ".b { padding: 4px; font-size: 10.5px; color: red; }", // 同一行里夹着别的声明
    ".c,",
    ".d { font: 12px/1.5 var(--font-sans); }", // 简写带行高 + 跨行选择器组
    "/* 注释掉的不算:font-size: 99px; */",
    "/* 跨行的注释也要剥干净,",
    "   font-size: 98px; */",
    ".e { font: 14px var(--font-serif); }", // 简写**不带**行高
    ".f { font: 600 15px/1.4 var(--font-sans); }", // 字号前面有字重 —— 本轮栽过的那一种
    ".g { font: inherit; }", // 整值关键字,不带字号
    ".h { font: var(--fs-13)/1.4 var(--font-sans); }", // 已经走令牌的简写
    ".i { font-size: 0.86em }", // 末条声明省略分号(靠 } 收尾)
  ].join(NL);
  const got = sizesOf(sample, "自检样本").map((r) => `${r.sel}=${r.value}`).join(" | ");
  // ⚠ 跨行选择器组只报最后一行(`.c,` → 报 `.d`),这是**实测出来的**行为不是期望,
  // 已记在 sizesOf 的边界里(341 同一条)。
  const want = [
    ".a=var(--fs-14)",
    ".b=10.5px",
    ".d=12px",
    ".e=14px",
    ".f=15px",
    ".h=var(--fs-13)",
    ".i=0.86em",
  ].join(" | ");
  if (got !== want) throw new Error(`抓取器自检不过:${NL}  抓到 [${got}]${NL}  期望 [${want}]`);

  // 阴性对照 ①:剥注释那一步真去掉的话,上面两条注释里的 99 / 98px 会被抓进来。
  const naive = [...sample.matchAll(/\bfont-size\s*:\s*([^;}]+)[;}]/g)].length;
  if (naive !== 5) {
    throw new Error(`自检的阴性对照 ① 失灵:不剥注释该抓到 5 条 font-size,实际 ${naive} 条 —— 样本被改动了?`);
  }
  // 阴性对照 ②:**假设「px 打头」的那种写法**(改写器第一版栽的地方)会漏掉 .f。
  // 这一刀专门守「简写解析别退回去」,因为退回去的表现是安静少判一条,不是报错。
  const naiveShorthand = [...sample.matchAll(/\bfont\s*:\s*(\d+(?:\.\d+)?)px/g)].length;
  if (naiveShorthand !== 2) {
    throw new Error(`自检的阴性对照 ② 失灵:假设「px 打头」该只认出 2 条(.d/.e、漏掉 .f),实际 ${naiveShorthand} 条`);
  }
  // 阴性对照 ③:认不出字号的 font 简写必须**抛**,不许静静跳过。
  let threw = false;
  try {
    sizesOf(".z { font: 600 clamp(9px, 1vw, 11px) serif; }", "自检样本");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("自检的阴性对照 ③ 失灵:认不出字号的 font 简写没有抛");
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
    if (got === undefined) say(`✗ ${s.name} ${s.file} 缺令牌 ${name}(规范 §2.2 有这一行)`);
    else if (got !== want) say(`✗ ${name} 漂移:规范 §2.2 写 ${want},${s.name} 写 ${got}`);
  }
}
for (const s of SOURCES) {
  for (const name of tokens.get(s.name).keys()) {
    if (!doc.has(name)) say(`✗ ${s.name} ${s.file} 定义了 ${name},而规范 §2.2 表里没有这一行`);
  }
}

// ②「最小档就是 §2.2 第一条」—— 阶下不许有档。
// 没有这一格的话,把某条红「修」掉的最省事办法就是往令牌表里加一个 --fs-9,
// 那等于从令牌那头把规范掏空,而且是安静的。
for (const [name, val] of doc) {
  const px = parseFloat(val);
  if (px < FLOOR) {
    say(`✗ 规范 §2.2 的阶里出现了小于 ${FLOOR}px 的档 ${name} = ${val} —— §2.2 第一条说信息性文字最小 ${FLOOR}px,` +
        `阶下无档;小字要留就进 ALLOW 逐处签字说明它是纯装饰,别把底线从令牌那头挖掉`);
  }
}

// ③ 登记表自身的形状:它是「阶管不到的」的出口,不是绕过收敛的后门。
ALLOW.forEach((a, i) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(a.value);
  if (m && parseFloat(m[1]) >= FLOOR) {
    say(`✗ 登记表第 ${i + 1} 条是 ${a.value}(≥ ${FLOOR}px)—— 那一档阶里就有,该走令牌而不是登记(${a.file} ${a.selector})`);
  }
  // ⚠ 只核「有没有写」,不核「写得够不够」:第一版拿 `why.length < 10` 当判据,当场在
  // 「▾ 空间下拉箭头」这种**已经说清楚了**的理由上误报八条。理由写得好不好只能靠人读,
  // 拿字数当代理会让这道闸开始说假话 —— 一道会误报的守卫比没有守卫更糟。
  if (!a.why || !a.why.trim()) say(`✗ 登记表第 ${i + 1} 条没写为什么(${a.file} ${a.selector})`);
});

// ④ 用法:扫描面按文件去重(与前四道同一件东西)
const seen = new Map();
for (const d of DOCS) for (const sh of sheetsOf(d)) if (!seen.has(sh.file)) seen.set(sh.file, sh.text);

const hitAllow = new Set();
const usedToken = new Set();
let decls = 0;
for (const [file, text] of seen) {
  for (const { sel, prop, value } of sizesOf(text, file)) {
    decls++;
    const tok = /^var\((--fs-[a-z0-9-]+)\)$/.exec(value);
    if (tok) {
      if (!doc.has(tok[1])) say(`✗ ${file}「${sel}」的 ${prop} 用了规范 §2.2 表里没有的令牌 ${tok[1]}`);
      usedToken.add(tok[1]);
      continue;
    }
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
  if (!usedToken.has(name)) say(`✗ ${name} 在规范 §2.2 表里有一行,而扫描面里一处都没人用 —— 定义了没人用的阶只是装饰`);
}

// ⑤ 探针:扫描面之外别再长出字号来。
for (const rel of ["index.html", "notebook.html", "android/index.html", "site/index.html"]) {
  const src = readFileSync(R(rel), "utf8");
  for (const m of src.matchAll(/style\s*=\s*"[^"]*font(-size)?\s*:/g)) {
    say(`✗ ${rel} 有行内 style 写字号(${m[0].slice(0, 40)}…)—— 不在扫描面内,先决定怎么核它`);
  }
}

const small = ALLOW.filter((a) => /px$/.test(a.value)).length;
console.log(
  `${NL}字号门禁:${decls} 处字号声明,` +
    `${doc.size} 个令牌(三份逐字对齐、与规范 §2.2 三方对账),登记的例外 ${ALLOW.length} 条` +
    `(小于 ${FLOOR}px 的纯装饰 ${small} 条 + 不是固定尺寸的形状 ${ALLOW.length - small} 条)。`,
);
console.log(`⚠ 诚实边界:只核值不核「谁该用哪一档」;§2.2 第二条「小 × 淡」由 check-contrast 守着(343 起它认字号),这道闸看不见;行高与字距仍不在任何闸的扫描面内。`);
process.exit(bad ? 1 : 0);
