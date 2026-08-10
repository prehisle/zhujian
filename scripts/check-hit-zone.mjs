#!/usr/bin/env node
// 热区门禁(356)—— §2.3 桌面「鼠标热区 ≥24×24px(WCAG 2.2)」的枚举面与纪律。
//
// # 它挡的是什么
//
// 354 修在册三违例(.chip-x ≈10×10 / .tag-x ≈11×11 / .img-del 18×18)时顺手就侦出
// 两处新的(.mb-chip-x 17×17 / .cm-close ≈14×14)—— 说明「靠审计点名」的清单天生
// 追不上地面:每加一枚小按钮都可能是下一处,而它出生那天没有任何东西会响。
//
// # 判据是「自保」,不是「测量」
//
// 真实渲染尺寸静态算不出(内容撑的宽、继承来的行高都在运行期),硬去估就会在 23/24px
// 的边界上误报 —— 而一道会误报的守卫比没有守卫更糟(342 §5)。所以这道闸不问
// 「它现在多大」,问「**它自己声明的东西能不能保证 ≥24**」:
//
//   · 显式 width/height/min-* ≥24(box-sizing 全局 border-box,声明即触区);
//   · 行盒下界:font-size × line-height + padding上下 + border ≥24
//     (行高没声明按 1 计 —— 全仓行高声明皆 ≥1,由下面的探针钉着;这是**下界**,
//     真实高度只会更大,故「≥24」的结论可靠、「<24」的结论这里永远不下);
//   · 宽度同理:padding左右 ≥24 即保证(内容只会再加宽);
//   · 热区扩展(354 技法):::before/::after 带 content + position:absolute +
//     宽高皆 ≥24,且**宿主自己是定位元素**——扩展挂在未定位宿主上会锚到别处去,
//     这是闸能当场抓的结构错。
//
// 给不出保证的签名**必须在登记表里有人签字**(check-hardcoded-colors 的模型:判据
// 不是「小 = 错」,是「每处都要有决定」)。WCAG 2.5.8 本身就带 spacing / inline 等
// 豁免,而「旁边够不够空」「算不算行内」恰恰只能人判 —— 登记表的 why 写的就是这个。
//
// # 枚举面从地面算
//
// 面 = 桌面两个文档(css-docs 的 DOCS)里,迷你层叠后 cursor:pointer 的元素签名
// (状态伪类 :hover 等归并回基签名)。不手写控件清单 —— 那种登记本身没人核
// (336 ⑩ 刀判过死刑)。新按钮只要照仓里惯例写了 cursor:pointer 就自动进面。
//
// # 它判不了什么(诚实边界,印在输出里)
//
//   · **宽度靠内容**的签名(文字按钮)不判宽 —— 窄内容(单枚字形)可能藏在这里,
//     但那一族几乎总是同时矮(字号小),会在高度轴被逮住;
//   · 扩展会不会被祖先 overflow **裁掉**、盖没盖到该盖的位置,静态看不见 ——
//     354 那三处真 Chrome 逐像素扫过,新增扩展照同法 scratch 实测(见 progress-log);
//   · 签名 ≠ DOM 元素:运行期元素还挂着别的类时,别的规则可能改写这里算出的值
//     (与 check-contrast 同一条边界);
//   · **安卓**不在面内:触屏 CSS 不写 cursor,静态没有可点信号;44px 那条底线的
//     实测走 live 资产 scripts/cdp-acceptance-p1-touch.js(144)。**官网**不在面内:
//     §2.3 是应用规范,官网今天仅 1 处 pointer(大按钮)。
//   · 没写 cursor:pointer 的可点元素进不了面(<a> 的 pointer 是 UA 给的)—— 桌面
//     控件惯例是每处都写,新控件不写的话这道闸看不见它。
//
// 用法:node scripts/check-hit-zone.mjs [--list]
// 全过 = 退出 0;无自保且未登记 / 登记表腐烂 / 扩展挂在未定位宿主 = 非零响亮。
// `--list` 逐签名打印判定与算出的保证值(处置与对拍都读它)。
// 发版门禁之一(见 docs/dev-and-testing.md)。

import { DOCS, sheetsOf, R } from "./lib/css-docs.mjs";
import { readFileSync } from "node:fs";

/** §2.3 桌面底线。别从这头把规范挖空 —— 有探针钉着它 ≥24。 */
const FLOOR = 24;

/** 定位值集合:扩展的宿主必须落在这里面,::before 的 absolute 才锚在它身上。 */
const POSITIONED = new Set(["relative", "absolute", "fixed", "sticky"]);

/**
 * 行高 <1 的声明登记:行盒下界按「行高 ≥1」算,任何 <1 的声明都可能挖空这个前提,
 * 必须逐条签字说明为什么不碰控件(探针会反向核对:登记的必须真存在)。
 */
const LH_BELOW_ONE = [
  { file: "src/sync.css", decl: "line-height: 0", why: "配对二维码容器压掉 svg 下方的行盒空隙,容器不是控件、里面只有 <svg>" },
];

/**
 * 无自保签名的登记表。一条 = 一个决定;cls 分类:
 *   inline   —— 行内目标(WCAG 2.5.8 inline 例外:嵌在文字流里,撑大会顶开排版)
 *   spacing  —— 周围留白足够(WCAG 2.5.8 spacing 例外:24px 圆不与邻近目标相交)/
 *               或它是全宽行、真实尺寸远超静态可证的部分
 *   native   —— UA 自绘控件(checkbox 等),尺寸不由本仓 CSS 说了算
 *   accepted —— 拍过板的在册例外:任何修法都会抢邻近目标的点击或动观感,权衡后接受
 *   pending  —— 真·待处置(357 清账后为空;新出现的红先修,修不动的才进这档排队)
 * 每条都被反向核对:不再命中 / 已有自保 = 红(过期的例外什么都不守)。
 */
const REGISTRY = [
  // ---- accepted:拍过板的在册例外(357)---------------------------------------------
  { selector: ".tf-caret", cls: "accepted", why: "折叠箭头嵌在 .tf-pill **内**、距 pill 文字 1px:自己比 24 窄,扩展横向必从宿主 pill 嘴里抢点击(筛选↔折叠是两个动作),权衡后维持现状;pill 本体已有热区扩展" },
  { selector: ".seg-btn", cls: "accepted", why: "明暗三档连体分段钮:.seg 容器 overflow:hidden 裁掉纵向外扩、段间 0 间隙裁掉横向,扩展一寸都伸不出去;实际高 23 差 1px,权衡后接受" },
  { selector: ".v-topics .color-swatch", cls: "accepted", why: "标签色板格 17×17 成栅格密排,扩展会互相抢点击,放大格子或拉开间距都动观感 —— 用户 2026-08-09 拍板不动观感、登记接受(点错再点一次的低频操作)" },
  { selector: ".v-topics .mb-chip-label", cls: "accepted", why: "合并条 chip 文字段(可点=设存续):自带 overflow:hidden 做 ellipsis,::before 被自己裁掉、扩展是死的(357 真机实测);摘 overflow 会破长名截断,权衡后接受 —— 点击面 = 文字全宽、高 ≈17" },
  { selector: "#cap-space", cls: "accepted", why: "捕获窗空间徽章:自带 overflow:hidden 截断长空间名,同上一条、本技法用不了;行盒 18、点击面 = 徽章全宽,权衡后接受" },
  // ---- spacing / inline / native:结构性豁免 ----------------------------------------
  { selector: ".v-topics .topic-head", cls: "spacing",
    why: "标签行整行可点(收缩展开),全宽,衬垫上下 22 + 行内容 ≥17 实际远超 24;行与行毗邻但整行即目标,撑大反而互相蚕食" },
  { selector: ".img-ref", cls: "inline", why: "正文里的「图N」引用,嵌在文字流(WCAG 2.5.8 inline 例外);撑大会顶开行距" },
  { selector: ".link-ref", cls: "inline", why: "正文里的链接引用,同上" },
  { selector: ".v-board .dont-ask", cls: "native", why: "「不再询问」label 含原生 checkbox,label 整体即触区、宽度由文字撑、高随行盒;点字即点框" },
  { selector: ".v-board .dont-ask input", cls: "native", why: "原生 checkbox,UA 自绘尺寸;外层 label 已是它的扩展触区" },
];

// ---- 解析件(与 check-contrast 同源同纪律;它是脚本不是库,故照抄不共享)------------

/** 顶层逗号切分(不切进括号里)。 */
function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** compound → {pos, neg};认不出的形状 null(fail-closed,不猜)。 */
function parseCompound(c) {
  const pos = new Set(), neg = new Set();
  let i = 0;
  const tag = /^[a-zA-Z][\w-]*/.exec(c);
  if (tag) { pos.add(tag[0]); i = tag[0].length; }
  while (i < c.length) {
    const ch = c[i];
    if (ch === "[") { const k = c.indexOf("]", i); if (k === -1) return null; pos.add(c.slice(i, k + 1)); i = k + 1; continue; }
    if (ch !== "." && ch !== "#" && ch !== ":") return null;
    if (ch === ":" && c[i + 1] === ":") return null; // 伪元素不并进宿主(扩展另有一条路)
    let j = i + 1;
    while (j < c.length && /[\w-]/.test(c[j])) j++;
    const name = c.slice(i, j);
    if (c[j] === "(") {
      let d = 0, k = j;
      for (; k < c.length; k++) { if (c[k] === "(") d++; else if (c[k] === ")") { d--; if (!d) { k++; break; } } }
      if (d !== 0) return null;
      const inner = c.slice(j + 1, k - 1).trim();
      if (name === ":not") {
        const sub = parseCompound(inner);
        if (sub === null || sub.neg.size) return null;
        for (const a of sub.pos) neg.add(a);
      } else {
        pos.add(c.slice(i, k));
      }
      i = k;
      continue;
    }
    pos.add(name);
    i = j;
  }
  return { pos, neg };
}

/** 单选择器 → 后代 compound 列表;带 >/+/~ 或认不出的一律 null。 */
function parseSelector(sel) {
  if (/[>+~]/.test(sel)) return null;
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    const c = parseCompound(p);
    if (c === null) return null;
    out.push(c);
  }
  return out;
}

const compoundApplies = (t, s) => {
  for (const a of t.pos) if (!s.pos.has(a)) return false;
  for (const a of t.neg) if (s.pos.has(a)) return false;
  for (const a of s.neg) if (t.pos.has(a)) return false;
  return true;
};

/** 规则 t 是否作用在签名 s 的元素上(主语对最后一节,前节按序子序列)。 */
function applies(t, s) {
  const n = t.length, m = s.length;
  if (n > m) return false;
  if (!compoundApplies(t[n - 1], s[m - 1])) return false;
  let si = 0;
  for (let ti = 0; ti < n - 1; ti++) {
    while (si < m - 1 && !compoundApplies(t[ti], s[si])) si++;
    if (si >= m - 1) return false;
    si++;
  }
  return true;
}

function specificity(compounds) {
  let a = 0, b = 0, c = 0;
  const count = (atom) => {
    if (atom.startsWith("#")) a++;
    else if (atom.startsWith(".") || atom.startsWith("[") || atom.startsWith(":")) b++;
    else c++;
  };
  for (const cp of compounds) { for (const x of cp.pos) count(x); for (const x of cp.neg) count(x); }
  return a * 10000 + b * 100 + c;
}

/** 状态伪类:归并回基签名用(:hover 的热区不是另一枚控件)。 */
const STATE_PSEUDO = new Set([
  ":hover", ":active", ":focus", ":focus-visible", ":focus-within",
  ":disabled", ":enabled", ":checked",
]);
function stripState(compounds) {
  return compounds.map(({ pos, neg }) => ({
    pos: new Set([...pos].filter((a) => !STATE_PSEUDO.has(a))),
    neg: new Set([...neg].filter((a) => !STATE_PSEUDO.has(a))),
  }));
}
const keyOf = (compounds) =>
  compounds.map((c) => [...c.pos].sort().join("") + "!" + [...c.neg].sort().join("")).join(" ");

// ---- 值解析 --------------------------------------------------------------------------

/** 桌面令牌表(亮色档就够 —— 尺寸令牌不随明暗翻面)。 */
const tokens = {};
{
  // 先摘注释再配平花括号 —— 注释里的 { } 会把 :root 块提前配平掉(--wc-w 就是这么丢的)
  const text = readFileSync(R("src/theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = text.indexOf(":root");
  const open = text.indexOf("{", at);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  for (const m of text.slice(open + 1, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens[m[1]] = m[2].trim();
  }
  if (!Object.keys(tokens).length) throw new Error("src/theme.css 的 :root 一个令牌都没解析到 —— 提取器失灵");
}

/** 值 → px;认得 `18px` / `0` / var(令牌)。别的(%、auto、calc、em)一律 null,不猜。 */
function toPx(value, depth = 0) {
  if (value === null || depth > 4) return null;
  const v = value.trim();
  if (v === "0") return 0;
  let m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  if (m) return +m[1];
  m = /^var\(\s*(--[a-z0-9-]+)\s*(?:,([\s\S]+))?\)$/.exec(v);
  if (m) {
    const def = tokens[m[1]];
    if (def !== undefined) return toPx(def, depth + 1);
    return m[2] ? toPx(m[2], depth + 1) : null;
  }
  return null;
}

/** padding 简写 → {top,right,bottom,left}(每格 px 或 null)。 */
function padBox(value) {
  const parts = value.trim().split(/\s+/).map((p) => toPx(p));
  if (parts.length === 1) return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  if (parts.length === 2) return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  if (parts.length === 3) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  if (parts.length === 4) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
  return { top: null, right: null, bottom: null, left: null };
}

/** border 简写 → 边宽 px。`none`/`0` = 0;取值里的首个 px;认不出 = 0(只会少算,保证不虚高)。 */
function borderPx(value) {
  const v = value.trim();
  if (v === "none" || v === "0") return 0;
  const m = /(-?\d+(?:\.\d+)?)px/.exec(v);
  return m ? +m[1] : 0;
}

/** `font` 简写里不带字号的合法整值(与 check-contrast/check-fs-drift 同源)。 */
const FONT_KEYWORDS = new Set([
  "inherit", "initial", "unset", "revert", "revert-layer",
  "caption", "icon", "menu", "message-box", "small-caption", "status-bar",
]);
const SIZE_TOKEN = /^(?:\d+(?:\.\d+)?px|var\(--fs-[a-z0-9-]+\))(?:\/\S*)?$/;

/**
 * 一条规则块里的判据声明。font 简写认不出字号一律抛(少认一种写法 = 安静地少判,
 * 342 那条 `font: 600 15px/1.4 …` 的纪律)。
 */
function declsIn(body, where) {
  const d = {};
  const grab = (prop) => {
    let out = null;
    for (const m of body.matchAll(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "g"))) {
      out = m[1].replace(/\s*!important\s*$/, "").trim();
    }
    return out;
  };
  for (const p of ["cursor", "width", "height", "min-width", "min-height", "position",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border", "border-width", "content", "overflow", "overflow-x", "overflow-y"]) {
    const v = grab(p.replace(/-/g, "\\-"));
    if (v !== null) d[p] = v;
  }
  // 字号/行高/font 简写按**书写序**走 —— `font: inherit; font-size: 10px;`(仓里 .chip-x
  // 就是这个形)里后写的 font-size 必须赢;先收长写再统一处理简写会把它抹掉。
  for (const m of body.matchAll(/(?:^|;)\s*(font-size|line-height|font)\s*:\s*([^;]+)/g)) {
    const val = m[2].replace(/\s*!important\s*$/, "").trim();
    if (m[1] !== "font") { d[m[1]] = val; continue; }
    if (FONT_KEYWORDS.has(val)) { delete d["font-size"]; delete d["line-height"]; continue; }
    const size = val.split(/\s+/).find((t) => SIZE_TOKEN.test(t));
    if (!size) {
      throw new Error(`${where} 的 font 简写里认不出字号:「${val}」—— 这只抓取器不猜,先教它认`);
    }
    const [fs, lh] = size.split("/");
    d["font-size"] = fs;
    if (lh !== undefined) d["line-height"] = lh; else delete d["line-height"];
  }
  return d;
}

// ---- 收规则、建面、判定 --------------------------------------------------------------

const problems = [];
const listed = [];
const stats = {
  face: new Map(), passExplicit: 0, passMath: 0, passExt: 0,
  widthBlind: 0, ambiguous: 0, unguarded: [],
};
const registryHit = new Map(); // entry -> [命中的签名]
const lhSeen = [];             // 全部 line-height 声明(探针 ⑤ 用)

for (const doc of DOCS.filter((d) => d.source === "桌面")) {
  const where = `${doc.source}·${doc.name}`;
  const rules = [];   // {file, sel, compounds, spec, order, d}
  const exts = [];    // {file, sel(host), compounds, d} —— ::before/::after 规则
  let order = 0;
  for (const sheet of sheetsOf(doc)) {
    const text = sheet.text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selRaw = rule[1].trim().replace(/\s+/g, " ");
      if (selRaw.startsWith("@") || selRaw.includes(":root")) continue;
      order++;
      const d = declsIn(rule[2], `${where} ${sheet.file}「${selRaw}」`);
      // 行高探针的料从解析结果取 —— font 简写里的 /行高 也得进来,只抓长写会漏
      if (d["line-height"] !== undefined) lhSeen.push({ file: sheet.file, sel: selRaw, v: d["line-height"] });
      if (!Object.keys(d).length) continue;
      for (const one of splitTop(selRaw)) {
        const sel = one.trim().replace(/\s+/g, " ");
        if (!sel) continue;
        const pm = /^(.*?)::(before|after)$/.exec(sel);
        if (pm) {
          const compounds = parseSelector(pm[1]);
          if (compounds !== null) exts.push({ file: sheet.file, sel, compounds, d });
          continue;
        }
        const compounds = parseSelector(sel);
        if (compounds === null) continue; // 认不出的形状:不进面也不参与层叠(fail-closed)
        rules.push({ file: sheet.file, sel, compounds, spec: specificity(compounds), order, d });
      }
    }
  }

  // 面:cursor:pointer 的签名,状态伪类归并回基形(:hover 的热区不是另一枚控件)。
  const face = new Map(); // key -> {sel, compounds, file}
  for (const r of rules) {
    if (r.d.cursor !== "pointer") continue;
    const base = stripState(r.compounds);
    const key = keyOf(base);
    const isBase = keyOf(r.compounds) === key;
    if (!face.has(key) || isBase) face.set(key, { sel: isBase ? r.sel : face.get(key)?.sel ?? r.sel, compounds: base, file: r.file });
  }
  stats.face.set(where, face.size);

  for (const sig of face.values()) {
    const acting = rules.filter((r) => applies(r.compounds, sig.compounds));
    /** 某属性的胜出声明;同权重跨文件冲突 = 静态定不了,当 null 并计数。 */
    const win = (prop) => {
      const cand = acting.filter((r) => r.d[prop] !== undefined);
      if (!cand.length) return null;
      const top = Math.max(...cand.map((r) => r.spec));
      const tied = cand.filter((r) => r.spec === top);
      if (new Set(tied.map((r) => r.file)).size > 1 && new Set(tied.map((r) => r.d[prop])).size > 1) {
        stats.ambiguous++;
        return null;
      }
      return tied.sort((a, b) => a.order - b.order).at(-1).d[prop];
    };

    // padding:简写与 longhand 都在时取小的(层叠先后静态定不准,保证只许少算不许多算)
    const sh = win("padding");
    const shBox = sh !== null ? padBox(sh) : { top: null, right: null, bottom: null, left: null };
    const side = (long, shv) => {
      const l = toPx(win(long));
      if (l !== null && shv !== null) return Math.min(l, shv);
      return l ?? shv;
    };
    const padTop = side("padding-top", shBox.top) ?? 0;
    const padBottom = side("padding-bottom", shBox.bottom) ?? 0;
    const padLeft = side("padding-left", shBox.left) ?? 0;
    const padRight = side("padding-right", shBox.right) ?? 0;
    const bord = (win("border-width") ?? win("border")) !== null ? borderPx(win("border-width") ?? win("border")) : 0;

    const fs = toPx(win("font-size"));
    const lhRaw = win("line-height");
    let lh = null;
    if (lhRaw !== null) {
      if (/^\d+(?:\.\d+)?$/.test(lhRaw)) lh = +lhRaw;
      // 非纯数字的行高(px/em)会破坏「行高 ≥1」下界,探针 ⑤ 统一处理,这里按未知走
    }

    const hExplicit = Math.max(toPx(win("height")) ?? -1, toPx(win("min-height")) ?? -1);
    const wExplicit = Math.max(toPx(win("width")) ?? -1, toPx(win("min-width")) ?? -1);
    // 行盒下界:字号 × 行高(未声明按 1;声明 <1 的按声明算,不许借「≥1 假设」翻身)。
    // 字号定不出时衬垫自己也是高度下界(内容只会再加高)—— .v-search .hit 靠这半过。
    const hMath = fs !== null || padTop + padBottom + bord > 0
      ? (fs ?? 0) * (lh ?? 1) + padTop + padBottom + 2 * bord : -1;
    const wPad = padLeft + padRight; // 内容只会再加宽

    // 热区扩展:content + absolute + 宽高皆 ≥ FLOOR,宿主必须已定位
    let extW = -1, extH = -1;
    for (const ex of exts) {
      if (!applies(ex.compounds, sig.compounds)) continue;
      const c = ex.d.content;
      if (c === undefined || c === "none") continue;
      if (ex.d.position !== "absolute") continue;
      const w = toPx(ex.d.width), h = toPx(ex.d.height);
      if (w === null || h === null || w < FLOOR || h < FLOOR) continue;
      const hostPos = win("position");
      if (hostPos === null || !POSITIONED.has(hostPos)) {
        problems.push(
          `${where} ${ex.file} ${ex.sel} 是热区扩展的形(content + absolute + ≥${FLOOR}),` +
            `宿主「${sig.sel}」却不是定位元素 —— absolute 会锚到最近的定位祖先身上去,` +
            `这枚扩展根本不跟着按钮走。给宿主补 position:relative(354 的形),或它已 absolute 则查层叠为何丢了`,
        );
        continue;
      }
      // 357:自剪裁宿主。宿主自己声明 overflow 非 visible 时,::before 会被**它自己**
      // 裁掉 —— 扩展是死的还在这儿冒充自保(.mb-chip-label 的 ellipsis / #cap-space,
      // 真 Chrome 实测「剥不剥完全一样」才露出来;祖先裁剪静态看不见,宿主自裁看得见)。
      const clip = [win("overflow"), win("overflow-x"), win("overflow-y")]
        .find((v) => v !== null && v !== "visible");
      if (clip !== undefined) {
        problems.push(
          `${where} ${ex.file} ${ex.sel} 是热区扩展,宿主「${sig.sel}」却自带 overflow: ${clip} ` +
            `—— 扩展会被宿主自己裁掉,是枚死扩展。这个宿主用不了本技法,删掉扩展、走 REGISTRY 登记`,
        );
        continue;
      }
      extW = Math.max(extW, w);
      extH = Math.max(extH, h);
    }

    const hGuar = Math.max(hExplicit, hMath, extH);
    const wGuar = Math.max(wExplicit, wPad, extW);
    const wUnknowable = wExplicit < 0; // 没写显式宽 = 内容撑宽,静态无上下界
    const hOk = hGuar >= FLOOR;
    const wOk = wGuar >= FLOOR || wUnknowable;
    const pass = hOk && wOk;

    const fmt = (n) => (n < 0 ? "?" : Math.round(n * 10) / 10);
    listed.push(
      `${pass ? "ok " : "RED"}  ${where}  ${sig.file}  ${sig.sel}  ` +
        `H[显式 ${fmt(hExplicit)} 行盒 ${fmt(hMath)} 扩展 ${fmt(extH)}] ` +
        `W[显式 ${fmt(wExplicit)} 衬垫 ${fmt(wPad)} 扩展 ${fmt(extW)}${wUnknowable ? " 内容撑宽" : ""}]`,
    );

    if (pass) {
      if (extH >= FLOOR && extH >= hExplicit && extH >= hMath) stats.passExt++;
      else if (hExplicit >= FLOOR) stats.passExplicit++;
      else stats.passMath++;
      if (wUnknowable && wGuar < FLOOR) stats.widthBlind++;
    }

    const entry = REGISTRY.find((e) => e.selector === sig.sel);
    if (entry) {
      if (!registryHit.has(entry)) registryHit.set(entry, []);
      registryHit.get(entry).push({ where, pass });
    }
    if (!pass && !entry) {
      stats.unguarded.push({ where, file: sig.file, sel: sig.sel });
      problems.push(
        `${where} ${sig.file} ${sig.sel} 给不出 ≥${FLOOR}×${FLOOR} 的自保:` +
          `高[显式 ${fmt(hExplicit)} / 行盒下界 ${fmt(hMath)} / 扩展 ${fmt(extH)}]、` +
          `宽[显式 ${fmt(wExplicit)} / 衬垫 ${fmt(wPad)} / 扩展 ${fmt(extW)}]。` +
          `要么给它自保(热区扩展 ::before 24×24,见 src/controls.css 354 那块;或显式尺寸),` +
          `要么在 scripts/check-hit-zone.mjs 的 REGISTRY 登记并写明豁免依据(inline/spacing/native/pending)`,
      );
    }
  }
}

// ---- 探针(失灵的方式是安静的绿,每层都得自己会响)------------------------------------

// ① 每个文档的面都不许空 —— 扫描器失灵时先响这条,而不是全绿。
for (const [w, n] of stats.face) {
  if (n === 0) problems.push(`${w} 一个 cursor:pointer 签名都没枚举到 —— 扫描器失灵,不是那里真的没有控件`);
}
// ② 扩展识别层还活着:354 那三处就是靠 ::before 过的,这一层塌了它们会齐齐变红,
//    但若有人先把它们登了记,塌掉就是安静的 —— 所以正向钉一条。
if (stats.passExt === 0) {
  problems.push("没有任何签名靠热区扩展(::before)过关 —— 354 那三处在仓里,扩展识别层失灵了");
}
// ③ 行盒下界那层还活着(字号/行高/衬垫的解析没整个塌掉)。
if (stats.passMath === 0) {
  problems.push("没有任何签名靠行盒下界(fs×lh+pad)过关 —— 尺寸解析层失灵了(令牌解析不到 / 抓取器认不出)");
}
// ④ 底线不许被悄悄放平:把 FLOOR 改小是让红消失的最省事写法,而它一条断言都不会红。
if (!(FLOOR >= 24)) {
  problems.push(`FLOOR(${FLOOR})低于 §2.3 的 24 —— 别从底线这头把规范挖空`);
}
// ⑤ 行高声明卫生:行盒下界建立在「行高 ≥1」上。<1 的声明必须逐条登记;
//    非纯数字(px/em)的行高今天仓里没有,冒出来当场响 —— 教会下界怎么算再放行。
for (const l of lhSeen) {
  if (/^\d+(?:\.\d+)?$/.test(l.v)) {
    if (+l.v < 1 && !LH_BELOW_ONE.some((e) => e.file === l.file && l.v.startsWith(e.decl.split(":")[1]?.trim() ?? "§"))) {
      problems.push(`${l.file}「${l.sel}」line-height: ${l.v} < 1 且未登记 —— 行盒下界的「行高 ≥1」前提被它挖了角`);
    }
  } else if (!/^var\(/.test(l.v)) {
    problems.push(`${l.file}「${l.sel}」line-height: ${l.v} 不是纯数字 —— px/em 行高会让行盒下界失真,先教这道闸怎么算`);
  }
}
for (const e of LH_BELOW_ONE) {
  if (!e.why?.trim()) problems.push(`LH_BELOW_ONE 里 ${e.file} 没写 why —— 空理由 = 没想过`);
  if (!lhSeen.some((l) => l.file === e.file && +l.v < 1)) {
    problems.push(`LH_BELOW_ONE 里 ${e.file} 的「${e.decl}」今天不存在了 —— 过期条目,删掉`);
  }
}
// ⑥ 登记表卫生:每条都得今天真的命中、真的还没有自保、真的写了 why。
for (const e of REGISTRY) {
  if (!e.why?.trim()) problems.push(`REGISTRY 里 ${e.selector} 没写 why —— 空理由 = 没想过,不许过`);
  if (!["inline", "spacing", "native", "accepted", "pending"].includes(e.cls)) {
    problems.push(`REGISTRY 里 ${e.selector} 的 cls「${e.cls}」不在四类里 —— 分类是给第③轮排工用的,别发明新词`);
  }
  const hits = registryHit.get(e);
  if (!hits) {
    problems.push(
      `REGISTRY 里 ${e.selector} 今天没命中任何签名 —— 选择器改名 / 控件删了 / 面变窄了,当场处理,别留着`,
    );
  } else if (hits.every((h) => h.pass)) {
    problems.push(`REGISTRY 里 ${e.selector} 如今已有自保 —— 删掉这条登记,别让它继续盖着后来的回退`);
  }
}

if (process.argv.includes("--list")) for (const l of listed.sort()) console.log(l);

if (problems.length) {
  console.error("热区门禁:不过\n");
  for (const p of problems) console.error("  ✗ " + p);
  console.error(`\n共 ${problems.length} 处。`);
  process.exit(1);
}

const byCls = {};
for (const e of REGISTRY) byCls[e.cls] = (byCls[e.cls] ?? 0) + 1;
console.log(
  `热区门禁通过:${[...stats.face.values()].reduce((a, b) => a + b, 0)} 个 cursor:pointer 签名` +
    `(${[...stats.face.entries()].map(([k, v]) => `${k} ${v}`).join(" / ")};状态伪类已归并)。\n` +
    `  自保:显式尺寸 ${stats.passExplicit} / 行盒下界 ${stats.passMath} / 热区扩展 ${stats.passExt};` +
    `登记 ${REGISTRY.length} 条(${Object.entries(byCls).map(([k, v]) => `${k} ${v}`).join(" / ")})。\n` +
    `  盲区(诚实边界,别让它悄悄变大):${stats.widthBlind} 个过关签名的宽度靠内容撑、静态只证了高;` +
    `同权重跨文件取值放弃 ${stats.ambiguous} 处;扩展会不会被祖先 overflow 裁掉这里看不见` +
    `(354 三处真 Chrome 扫过,新增扩展照同法实测);安卓(无 cursor 信号,live 走 ` +
    `cdp-acceptance-p1-touch)与官网(非 §2.3 约束面)不在面内。`,
);
