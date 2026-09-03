#!/usr/bin/env node
// 明暗两档的对比度门禁 —— 328 那道门禁只比对**令牌定义**,这一道管**用法**。
//
// # 它挡的是什么(两个真判例,都是 336 这一轮量出来的)
//
// ① `.copy-toast` / `.zoom-badge` 写 `color:#fff; background:var(--ink)`。亮色档下是
//    「墨底纸字」,没问题;而暗色档里**墨本身是浅的**(--ink: #ece4d5),于是变成白字
//    压白底,**实测 1.26:1,肉眼近乎看不见**。250 加暗色三档时没人回头看这些写死的白。
// ② 同一个「朱砂主按钮」的前景,三端各写各的白(桌面 #fdf6ee / 安卓 #fff / 官网
//    #faf6ec)—— 令牌表逐字对齐了,用法却是三个值。已收进 --on-seal。
//
// 顺带还有一条独立规则(见下 ③):**引用了哪份令牌表都没有的名字**。`var(--x, 兜底)`
// 会静默退回兜底值(判例 `--seal-deep`:那个 hover 因此几乎没有反馈),不给兜底则整条
// 声明作废(判例 `--rule`:看板的标签搜索框**从来就没有边框**,而灵感侧有)。两种都不响。
//
// # 337 加的那一层:**同一个元素身上的迷你层叠**
//
// 336 版只判「同一条规则里自带前景与背景」的组合,于是 `.x:hover { background: … }` 这种
// **只改一半**的规则整条被跳过 —— hover 这一族全在盲区里。336 排队第 1 条(暗色档 hover
// 把朱砂压得更暗)就是这么活下来的,它自己在注记里写着「这道门禁判不到它」。
//
// 现在按元素判,不按规则判:每个选择器 = 一个「元素签名」,它的生效前景/背景由**同一份
// 里所有作用在这个元素上的规则**按(特异性,文档顺序)层叠算出。因此
// `.v-topics .mb-btn.go:hover:not(:disabled)` 的背景取自它自己、字取自 `.mb-btn.go`。
//
// 这一层当场抓到第二个判例:`.v-topics .mb-btn:hover:not(:disabled)` 是 (0,4,0),**压过**
// `.mb-btn.go` 的 (0,3,0),于是「合并」钮一悬停,字就从 --on-seal 掉回 --ink ——
// 亮色档下**墨黑压朱砂 2.53:1**。这个洞跨两条规则,只看单条规则的版本永远看不见。
//
// # 它**判不了**什么(诚实边界,别把绿当成「全站可读」)
//
// 层叠只在**同一个元素**身上做。背景来自**祖先**(`background:transparent` 或压根没写)
// 的,静态判不了 —— 那需要真实 DOM。跑一次会打印跳过的条数与分类,那个数字就是这道门禁
// 的盲区大小,别让它悄悄变大。
// 半透明背景(rgba / color-mix 掺 transparent)同理跳过:合成结果取决于底下压着谁。
// 另外三类一律 fail-closed(宁可不判,不猜):
//   · 形状认不出的选择器(非后代组合子 `>`/`+`/`~`、属性选择器),**以及被它们波及的签名**
//   · 伪元素(`::before` 的背景是它自己的盒子,不是宿主的)
//   · 同权重跨文件冲突 —— 桌面的 CSS 由 JS 模块图决定加载次序,静态看不出谁在后面
//
// # 338 加的那一层:**一次层叠 = 一个文档**
//
// 337 版把「桌面」当一整份层叠,src/*.css 全并在一起,而两个 html 壳里的内联 `<style>`
// 压根没扫(337 排队第 1 条)。桌面其实是**两个窗口壳**:capture 窗(index.html)与
// notebook 窗(notebook.html),各自加载各自那批 CSS。现在按文档层叠,清单由
// `scripts/lib/css-docs.mjs` 从 html + 静态模块图**算出来**(不是手写登记表 —— 那种
// 东西 336 的 ⑩ 刀判过死刑:登记本身没人核)。当场抓到 `.wc-close:hover` 的前景写死
// `#fdf6ee`,是 336 收 `--on-seal` 那一族的漏网(它住在 notebook 壳里,旧版看不见)。
//
// # 343 加的这一层:**字号**(§2.2 第二条)
//
// 「小于 14px 的文字禁止与低对比色叠加(小 × 淡 = 不可读)」——审计 #25 的另一半,342 之前
// 一直是文档里的一句话:那道字号门禁只管值落不落在阶上,这道门禁只算比值,**两边都没有
// 「小 × 淡」这个组合的概念**。343 把字号接进来:每个签名的生效字号照同一套迷你层叠算出,
// 小于 14px 的那一档换一条更高的底线(见 SMALL_FLOOR)。
//
// ⚠ **字号是继承来的,而这套层叠只在同一个元素身上做**。自己那条链上没人写 font-size 的
// 签名,静态定不出它多大 —— 那种一律**按 4.5 判**(与 343 之前一模一样)并单独计数印出来。
// 这个方向是 fail-open 的:不知道多大就不上那条更严的底线。不这么做的两条路都更糟 ——
// 猜「继承自 body」会在小容器里判漏(安静的绿),猜「就是小字」会误报(342 §5:一道会
// 误报的守卫比没有守卫更糟)。那个数字就是这一格的盲区,别让它悄悄变大。
//
// 用法:node scripts/check-contrast.mjs [--list]
// 全过 = 退出 0;低于 AA(4.5:1)且没登记 / 幽灵令牌 / 登记表腐烂 = 非零响亮。
// `--list` 打印今天判到的每一组(份 / 文档 / 文件 / 签名 / 档 / 生效前后景 / 比值)—— 加它
// 是因为 337 的层叠是**算出来的**,得有个出口能把它跟真浏览器的 getComputedStyle 对一遍。
// 发版门禁之一(与 check-lock-drift、check-theme-drift 并列,见 docs/dev-and-testing.md)。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DOCS, DOCS_ALL, IN_WORK_REPO, PRIVATE_SKIPPED, sheetsOf, R } from "./lib/css-docs.mjs";

/** WCAG AA 正文档。界面里没有「大字号」豁免的地方(按钮 12–14px 是正文档)。 */
const FLOOR = 4.5;

/**
 * §2.2 第二条那一格(343):**小于 SMALL_PX 的文字换一条更高的底线**。
 *
 * 判据不是「小字禁止用某几个令牌」而是「小字这一档的比值门槛更高」——前者要维护一张
 * 「哪些令牌算淡」的名单,而**名单本身没人核**(336 ⑩ 刀判过死刑的那一族);后者直接
 * 落在这道门禁已经算得出来的那个数上。
 *
 * ⭐ **5.0 是量出来的,不是拍的**。四档的代价在今天的 102 组小字上实算过:
 *
 *   底线   今天新红            备注
 *   5.0    2 组 / 2 选择器      本轮取的
 *   5.5    40 组 / 23 选择器    其中 31 组是朱砂主按钮
 *   6.0    53 组 / 29 选择器
 *   7.0    60 组 / 29 选择器    WCAG AAA
 *
 * 坎在 **5.32**:朱砂主按钮那对色(`--on-seal` 压 `--seal`)就是 5.32,336 用户拍板定的
 * (暗色档换深字,5.32),它铺在三端所有主按钮上。任何高过 5.32 的底线 = 要么重挑品牌
 * 主色,要么往 ALLOW 里塞二十几条 —— 而**一道要靠二十几条例外才过得去的闸,已经在说假话**
 * (342 §5 那条:一道会误报的守卫比没有守卫更糟)。于是可取的区间是 (4.5, 5.32],取整数
 * 档 **5.0**。用户 2026-08-08 在这张代价表上拍的板。
 *
 * ⚠ 换句话说 5.0 不是「AAA 那种有出处的数」,它是**本设计系统里能与既有主色共存的最高
 * 一档**。哪天朱砂那对色改了(比如为了 AAA 重挑),这个数就该重新算 —— 别当成常量抄走。
 */
const SMALL_PX = 14;
const SMALL_FLOOR = 5;
/** 字号定不出来(继承自祖先)时按 FLOOR 判 —— 见头部「343 加的这一层」。 */
const floorFor = (px) => (px !== null && px < SMALL_PX ? SMALL_FLOOR : FLOOR);

/**
 * 暗色档的两种挂法:客户端由 theme-mode 单点写 data-theme 属性,官网走 @media 跟随
 * 系统。**两种都主动去找**,别在这里手写「这份是哪种」—— 写死的那种声明一旦与事实
 * 不符,门禁只会安静地少看一半(336 的阴性对照在 check-theme-drift 上量到过)。
 */
const DARK_FORMS = [':root[data-theme="dark"]', "@media (prefers-color-scheme: dark)"];

// 「份」(令牌表归属)与「文档」(一次层叠的作用域)见 scripts/lib/css-docs.mjs 的 DOCS。
// 三份今天都有暗色档,没有暗色的一律当失灵报。

/**
 * 仓里的 html 而**不是**应用壳的,登记在这里并写明为什么。今天一条都没有。
 * 有了它,css-docs 的 DOCS 就是两个方向都核的:DOCS 里点名的文件读不到会当场抛,
 * 地面上多出来的 html 会被下面那道探针拦住 —— 少一个文档是安静的少判(336 ⑩ 刀那族)。
 */
const NOT_A_DOC = [
  ...["site-cool/privacy-rights.html", "site-cool/terms.html",
      "site-app-docs/privacy.html", "site-app-docs/privacy-rights.html", "site-app-docs/terms.html"].map((file) => ({
    file,
    why: "同一个 `docPage()` 模板(scripts/build-site-cool.mjs)生成的另一份,内联样式**逐字节相同** \
⇒ 判据落在已登记进 DOCS 的 `site-cool/privacy.html` 那一份上,判第二遍不产生任何新信息。\
产物与源一致由 `branch-gate land` 那道 `build-site-cool.mjs --check` 守着。\
⚠ **触发门**:备案号下来后 `site-app-docs/` 那三份要撤(deploy §8.1a),那时把这三条一起删 —— \
留着会被下面那道「过期条目」探针当场逮住",
    privateOnly: true, // 见下面 IN_WORK_REPO 那段:公开快照上这几份根本不存在
  })),
  {
    file: "site-cool/index.html",
    privateOnly: true,
    why: "它的 `<style>` 是从 `site/index.html` **整段照抄**的产物(生成器只换下载区与页脚导航)\
⇒ 配色 / 字号由「官网·单页」那一格判,判第二遍不产生新信息;而把它登记成文档要把 \
`check-fs-drift` 与 `check-hardcoded-colors` 的登记表**各抄一份**(实测多出 3 + 8 条同源例外)—— \
复制登记表是全仓最会腐的那种东西。两者一致由 `branch-gate land` 那道 `build-site-cool.mjs --check` 守着",
  },
  {
    file: "ohos/index.html",
    why: "OH-c/C3 的**验收面**不是产品界面:它把六条复核面各显成一个读数(启动闸 JSON / 路径落点 / \
真 command 往返),整页零 CSS、零颜色声明、只有浏览器默认样式 —— 没有配色可判。\
⚠ **触发门**:OH-d 抄 android/src 那份真前端进来时,这一条就该删掉,鸿蒙端按第四个前端产物登记进 DOCS",
  },
];

/**
 * 低于 AA 但**判定可接受**的登记表。一条 = 一个决定,必须写清楚为什么。
 * 每条都会被反向核对:今天不再命中它 = 红(过期的例外什么都不守)。
 */
const ALLOW = [
  {
    source: "桌面",
    file: "src/topics.css",
    selector: ".v-topics .color-swatch.none",
    why: "--ink-faint 在令牌表里就定义为「提示 / 禁用」级,本就该比正文淡;这里是「不着色」\
色板格里的那个占位符号,不是要读的字",
  },
  {
    source: "桌面",
    file: "src/topics.css",
    selector: ".v-topics .dtask-copy",
    why: "同上,--ink-faint 的提示级:标签详情里那个复制按钮,悬停时才升到 --ink",
  },
  {
    source: "安卓",
    file: "android/index.html#style",
    selector: ".tc-swatch.none",
    why: "桌面 .color-swatch.none 的安卓同族(user-44 第二刀把调色板搬上手机):同一枚「不着色」\
占位符号、同一条理由 —— 不是要读的字,两端同形优先于单侧改设计",
  },
];

/**
 * 运行期由 JS 注入的自定义属性 —— 它们**不在**任何令牌表里是对的,不是幽灵。
 * 每条都要能指出注入点,否则就是把真幽灵放进来了。
 */
const RUNTIME_VARS = [
  { name: "--tag-color", where: "src/tag-color.ts / src/filter-bar.ts 按标签自定义色 setProperty" },
  { name: "--tc", where: "安卓侧同一件事(android/src/filter.ts 等),chip 上的行内 style" },
  { name: "--nav-h", where: "android/src/main.ts 量出底栏实高后写根元素,供悬浮钮定位" },
  {
    name: "--ck-indent",
    where:
      "正文待办清单的嵌套缩进层数(桌面 src/item-images.ts::renderContent 的 setProperty /" +
      " 安卓 android/src/ui.ts::contentHtml 的行内 style);兜底 0 = 不缩进,那正是绝大多数行",
  },
];

// ---- 解析 ---------------------------------------------------------------------------

/** 取 `selector { … }` 的块体(花括号配平);配不平就抛,别猜。 */
function blockBody(src, selector) {
  const at = src.indexOf(selector);
  if (at === -1) return null;
  const open = src.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`${selector} 的 { 没有配平的 }`);
}

function declsOf(body) {
  const bag = {};
  if (!body) return bag;
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) bag[m[1]] = m[2].trim();
  return bag;
}

/** 一份的令牌表:{light, dark}。两种暗色挂法都探,@media 那种再往里剥一层 :root。 */
function tokensOf(text) {
  const light = declsOf(blockBody(text, ":root {") ?? blockBody(text, ":root{"));
  for (const form of DARK_FORMS) {
    let darkBody = blockBody(text, form);
    if (darkBody === null) continue;
    if (form.startsWith("@media")) {
      darkBody = blockBody(darkBody, ":root {") ?? blockBody(darkBody, ":root{");
    }
    const dark = declsOf(darkBody);
    if (Object.keys(dark).length > 0) return { light, dark };
  }
  return { light, dark: {} };
}

// ---- 字号(343)----------------------------------------------------------------------

/** `font` 简写里不带字号的合法整值。与 check-fs-drift 的同名表同源 —— 认不出的一律抛。 */
const FONT_KEYWORDS = new Set([
  "inherit", "initial", "unset", "revert", "revert-layer",
  "caption", "icon", "menu", "message-box", "small-caption", "status-bar",
]);

/** 字号那一格的形状:`13px` 或 `var(--fs-13)`(简写里可能带 `/行高`)。 */
const SIZE_TOKEN = /^(?:\d+(?:\.\d+)?px|var\(--fs-[a-z0-9-]+\))(?:\/\S*)?$/;

/**
 * 一条规则块里生效的字号声明(没有则 null)。`font-size:` 与 `font:` 简写都算,同一块里
 * **后来者胜**(`font` 简写会把 font-size 一起重置,CSS 就是这么定的)。
 *
 * ⚠ 认不出字号的 `font:` 一律抛,不许静静跳过 —— 342 那条 `font: 600 15px/1.4 …`
 * (字号前面还能有字重)就是靠这条纪律才露出来的:少认一种写法 = 安静地少判。
 */
function fontSizeIn(body, where) {
  let out = null;
  for (const m of body.matchAll(/(?:^|;)\s*(font-size|font)\s*:\s*([^;]+)/g)) {
    const val = strip(m[2]);
    if (m[1] === "font-size") { out = val; continue; }
    const size = val.split(/\s+/).find((t) => SIZE_TOKEN.test(t));
    if (size) { out = size.split("/")[0]; continue; }
    if (FONT_KEYWORDS.has(val)) { out = null; continue; } // 整值关键字:字号跟着继承走
    throw new Error(
      `${where} 的 font 简写里认不出字号:「${val}」—— 这只抓取器不猜。` +
        `多半是又冒出一种写法,先教它认(check-fs-drift 的 sizesOf 是同一条纪律)`,
    );
  }
  return out;
}

/** 字号值 → px 数。认得 `13px` 与 `var(--fs-13)`;别的(em / clamp / 认不出)一律 null,不猜。 */
function toPx(value, tok, depth = 0) {
  if (depth > 4) return null;
  const v = value.trim();
  let m = /^(\d+(?:\.\d+)?)px$/.exec(v);
  if (m) return +m[1];
  m = /^var\(\s*(--fs-[a-z0-9-]+)\s*\)$/.exec(v);
  if (m) {
    const def = tok.light[m[1]];
    return def === undefined ? null : toPx(def, tok, depth + 1);
  }
  return null;
}

// ---- 颜色 ---------------------------------------------------------------------------

function fromHex(h) {
  if (h.length === 4) h = "#" + [...h.slice(1)].map((c) => c + c).join("");
  if (h.length === 7) return { r: +("0x" + h.slice(1, 3)), g: +("0x" + h.slice(3, 5)), b: +("0x" + h.slice(5, 7)), a: 1 };
  if (h.length === 9)
    return {
      r: +("0x" + h.slice(1, 3)), g: +("0x" + h.slice(3, 5)), b: +("0x" + h.slice(5, 7)),
      a: +("0x" + h.slice(7, 9)) / 255,
    };
  return null;
}

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

/**
 * 把一个颜色值算成 {r,g,b,a}。认得:十六进制 / rgb(a) / transparent / var() / color-mix(in srgb)。
 * 认不得的返回 null(调用方跳过并计入盲区,**不猜**)。
 * `seen` 收集途中引用过的自定义属性名,供幽灵令牌那条规则用。
 */
function toRgb(value, tok, mode, seen, depth = 0) {
  if (depth > 8) return null;
  const v = value.trim();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (v.startsWith("#")) return fromHex(v);

  let m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  m = /^var\(\s*(--[a-z0-9-]+)\s*(?:,([\s\S]+))?\)$/.exec(v);
  if (m) {
    seen?.add(m[1]);
    // 暗色档没重定义就落回亮色档(CSS 的实际级联行为)。
    const def = tok.dark[m[1]] ?? tok.light[m[1]];
    const val = mode === "dark" ? def : tok.light[m[1]];
    if (val !== undefined) return toRgb(val, tok, mode, seen, depth + 1);
    return m[2] ? toRgb(m[2], tok, mode, seen, depth + 1) : null;
  }

  m = /^color-mix\(\s*in\s+srgb\s*,([\s\S]+)\)$/.exec(v);
  if (m) {
    const parts = splitTop(m[1]);
    if (parts.length !== 2) return null;
    const one = (s) => {
      const mm = /^([\s\S]+?)\s+([\d.]+)%$/.exec(s.trim());
      return mm ? { c: mm[1], p: +mm[2] } : { c: s.trim(), p: null };
    };
    const a = one(parts[0]), b = one(parts[1]);
    let pa = a.p, pb = b.p;
    if (pa === null && pb === null) (pa = 50), (pb = 50);
    else if (pa === null) pa = 100 - pb;
    else if (pb === null) pb = 100 - pa;
    if (pa + pb === 0) return null;
    pa /= pa + pb; pb = 1 - pa;
    const ca = toRgb(a.c, tok, mode, seen, depth + 1);
    const cb = toRgb(b.c, tok, mode, seen, depth + 1);
    if (!ca || !cb) return null;
    const al = ca.a * pa + cb.a * pb;
    if (al === 0) return { r: 0, g: 0, b: 0, a: 0 };
    // 按预乘 alpha 混合(CSS color-mix 在 srgb 里就是这么算的)
    return {
      r: (ca.r * ca.a * pa + cb.r * cb.a * pb) / al,
      g: (ca.g * ca.a * pa + cb.g * cb.a * pb) / al,
      b: (ca.b * ca.a * pa + cb.b * cb.a * pb) / al,
      a: al,
    };
  }
  return null;
}

const lin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
function contrast(a, b) {
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
}

// ---- 选择器与迷你层叠(337)-----------------------------------------------------------

/**
 * 一个 compound(`.a.b:hover:not(:disabled)`)拆成原子:{ pos, neg }。
 * `:not(X)` 进 neg(它是**负条件**,不是要求对方也写一遍)。认不出的形状返回 null ——
 * 一律 fail-closed,这道门禁宁可少判也不许猜。
 */
function parseCompound(c) {
  const pos = new Set(), neg = new Set();
  let i = 0;
  const tag = /^[a-zA-Z][\w-]*/.exec(c);
  if (tag) { pos.add(tag[0]); i = tag[0].length; }
  while (i < c.length) {
    const ch = c[i];
    if (ch === "[") { const k = c.indexOf("]", i); if (k === -1) return null; pos.add(c.slice(i, k + 1)); i = k + 1; continue; }
    if (ch !== "." && ch !== "#" && ch !== ":") return null;
    if (ch === ":" && c[i + 1] === ":") return null; // 伪元素:另一个盒子,不并进宿主
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
        if (sub === null || sub.neg.size) return null; // :not(:not(…)) / 选择器列表:不猜
        for (const a of sub.pos) neg.add(a);
      } else {
        pos.add(c.slice(i, k)); // `:nth-child(2)` 之类整体当一个原子
      }
      i = k;
      continue;
    }
    pos.add(name);
    i = j;
  }
  return { pos, neg };
}

/** 单选择器 → 后代 compound 列表。带 `>`/`+`/`~` 或认不出的原子一律 null。 */
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

/** 规则 t 是否作用在「签名 s 描述的那个元素」上。主语必须对上最后一节,前面按序做子序列。 */
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

/** (id, 类/属性/伪类, 标签)压成一个可比的数。`:not(X)` 的权重来自 X 本身。 */
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

// ---- 门禁 ---------------------------------------------------------------------------

const problems = [];
const judged = [];                 // 判定过的组合
const blind = new Map();           // 盲区分类计数
const perDoc = new Map();          // 每个文档判了多少组(反向探针用)
const loadedCss = new Set();       // 各文档真加载到的样式文件(覆盖探针用)
const docSheets = [];              // 每个文档的外部样式集合(分文档探针用)
const allowHit = new Set();
const varsSeen = new Set();
const definedVars = new Set();
let crossRule = 0;                 // 至少有一半来自别的规则的组数(337 那一层的产出)
let stateJudged = 0;               // 带状态伪类(:hover 等)的签名判到了几组
let sizeSmall = 0, sizeBig = 0, sizeUnknown = 0; // 签名的字号:小字 / 不小 / 定不出来(343)

const bump = (k) => blind.set(k, (blind.get(k) ?? 0) + 1);
const strip = (v) => v.replace(/\s*!important\s*$/, "").trim();

/** 令牌表按「份」算一次:同一份下的多个文档共用一张表(桌面两个窗口壳就是)。 */
const tokCache = new Map();
function tokensFor(s) {
  if (tokCache.has(s.source)) return tokCache.get(s.source);
  const tok = tokensOf(readFileSync(R(s.tokens), "utf8"));
  if (Object.keys(tok.light).length === 0) {
    problems.push(`${s.source}(${s.tokens})的 :root 一个令牌都没解析到 —— 提取器失灵,不是那里真的空着`);
  }
  if (Object.keys(tok.dark).length === 0) {
    problems.push(
      `${s.source}(${s.tokens})两种暗色挂法(${DARK_FORMS.join(" / ")})都没解析到令牌` +
        ` —— 要么它真的没有暗色档(那这道门禁只判了一半),要么提取器失灵`,
    );
  }
  for (const k of Object.keys(tok.light)) definedVars.add(k);
  for (const k of Object.keys(tok.dark)) definedVars.add(k);
  tokCache.set(s.source, tok);
  return tok;
}

// ⚠ 「只在工作仓里有」的那几格由 `css-docs.mjs` 统一过滤(理由与那趟红的经过写在那儿:
//    四道 CSS 门禁都读这张表,住在这一道里治不好另外三道)。这里只负责**把跳过的印出来**。
if (PRIVATE_SKIPPED.length) {
  console.log(`⚠ 公开快照上跳过 ${PRIVATE_SKIPPED.length} 个「只在工作仓里有」的文档:${PRIVATE_SKIPPED.join(" / ")}`);
  console.log(`   (它们在 .export-excluded.json 里,这棵树上根本没有 —— 判据在工作仓那边跑得到)`);
}

for (const doc of DOCS) {
  const where = `${doc.source}·${doc.name}`;
  const tok = tokensFor(doc);

  // ① 收规则。一条 `a, b { … }` 拆成两条独立规则(层叠上它们本来就是两条)。
  const rules = [];
  const opaqueSubjects = new Set(); // 形状认不出的**带颜色**规则的主语原子 —— 被它波及的签名一律不判
  const fsOpaque = new Set();       // 同上,但**带字号**的:被它波及的签名字号算「不知道」(343)
  let order = 0;
  const mySheets = sheetsOf(doc);
  docSheets.push({
    source: doc.source, where,
    // 只记**外部**样式文件:内联段天生只属于一个文档,拿它比较是平凡成立的
    ext: new Set(mySheets.map((s) => s.file).filter((f) => !f.includes("#style"))),
  });
  for (const sheet of mySheets) {
    const file = sheet.file;
    loadedCss.add(file);
    const text = sheet.text.replace(/\/\*[\s\S]*?\*\//g, "");
    // @ 块里出现带颜色的规则 = 明暗归属会算错(本门禁按 data-theme / @media 两档取令牌,
    // 而 @ 块内的规则只在特定条件下生效)。今天一条都没有;哪天有了当场响,别静默算错。
    for (const at of text.matchAll(/@[^{]+\{/g)) {
      const open = at.index + at[0].length - 1;
      let d = 0, end = text.length;
      for (let i = open; i < text.length; i++) {
        if (text[i] === "{") d++;
        else if (text[i] === "}") { d--; if (!d) { end = i; break; } }
      }
      const inner = [...text.slice(open + 1, end).matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      // 343 起字号也在里面:@ 块里的 `font-size` 会被下面那只扁平抓取器当成无条件生效的,
      // 于是「窄屏才 11px」这种声明会被算成恒 11px(或反过来),两个方向都可能算错。
      const colored = inner.filter((r) =>
        /(?:^|;)\s*(?:color|background(?:-color)?|font(?:-size)?)\s*:/.test(r[2]),
      );
      if (colored.length) {
        problems.push(
          `${where} ${file} 的 ${at[0].slice(0, 40).trim()} 块里有带颜色或字号的规则` +
            `(${colored.map((r) => r[1].trim()).join(" / ")})—— 这道门禁按明暗两档取令牌、` +
            `按扁平的文档顺序层叠,条件块内的规则归哪一档、什么时候生效它都不知道,会算错。` +
            `要么把它挪出来,要么在这里教它怎么归档`,
        );
      }
    }
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selRaw = rule[1].trim().replace(/\s+/g, " ");
      if (selRaw.startsWith("@") || selRaw.includes(":root")) continue;
      const body = rule[2];
      // 幽灵令牌那条规则要看**全部**颜色位置的 var(),不只自带前后景的那些
      for (const m of body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) varsSeen.add(m[1]);
      const fgm = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(body);
      const bgm = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(body);
      const fsv = fontSizeIn(body, `${where} ${file}「${selRaw}」`);
      order++;
      if (!fgm && !bgm && !fsv) continue;
      for (const one of splitTop(selRaw)) {
        const sel = one.trim().replace(/\s+/g, " ");
        if (!sel) continue;
        const compounds = parseSelector(sel);
        if (compounds === null) {
          // 认不出形状:它自己不判。**是否连累别人**要分两种:
          //   · 伪元素(`::before`)—— 它是另一个盒子,盖不到宿主的前景/背景,不污染
          //   · 真的组合子(`>`/`+`/`~`)—— 它可能盖在某个签名上而我算不出,
          //     那就**凡是可能被它盖到的签名一律不判**(fail-closed)
          // ⚠ 343:两个维度**分开毒**。同一条认不出的规则,带颜色的毒颜色、带字号的毒字号,
          // 不许互相牵连 —— 一条只写 font-size 的 `>` 规则若把整个签名拖进盲区,颜色那一格
          // 就白白丢了覆盖(而它对颜色本来什么都盖不到);反过来,一条只写颜色的 `>` 规则
          // 也不该让字号变成「不知道」。
          if (/[>+~]/.test(sel)) {
            const subject = sel.split(/\s+/).pop();
            const atoms = [...subject.matchAll(/[.#]?[\w-]+/g)].map((m) => m[0]);
            if (fgm || bgm) {
              for (const a of atoms) opaqueSubjects.add(a);
              bump("选择器形状认不出(非后代组合子)");
            }
            if (fsv) for (const a of atoms) fsOpaque.add(a);
          } else if (fgm || bgm) {
            bump("伪元素(它的背景是自己的盒子,不是宿主的)");
          }
          continue;
        }
        rules.push({
          file, sel, compounds, spec: specificity(compounds), order,
          fg: fgm ? strip(fgm[1]) : null, bg: bgm ? strip(bgm[1]) : null,
          fs: fsv, seed: !!(fgm || bgm),
        });
      }
    }
  }

  // ② 每个不同的选择器 = 一个元素签名;生效前景/背景由作用在它身上的规则层叠算出。
  const seenSig = new Set();
  let n = 0;
  for (const sig of rules) {
    if (seenSig.has(sig.sel)) continue;
    // 签名的**来源**仍只取自带颜色的规则(343 之前就是这个集合)。只写 font-size 的规则
    // 进 rules 是为了层叠算得出字号,不该顺带把签名集扩大 —— 那是另一件事,记在排队里。
    if (!sig.seed) continue;
    seenSig.add(sig.sel);
    const subject = sig.compounds[sig.compounds.length - 1];
    if ([...subject.pos].some((a) => opaqueSubjects.has(a))) {
      bump("被形状认不出的规则波及(宁可不判)");
      continue;
    }
    const acting = rules.filter((r) => applies(r.compounds, sig.compounds));
    /** 取某个属性的胜出声明。同权重跨文件冲突 = 加载次序静态看不出,不判。 */
    const win = (prop) => {
      const cand = acting.filter((r) => r[prop] !== null);
      if (!cand.length) return { v: null };
      const top = Math.max(...cand.map((r) => r.spec));
      const tied = cand.filter((r) => r.spec === top);
      const files = new Set(tied.map((r) => r.file));
      const vals = new Set(tied.map((r) => r[prop]));
      if (files.size > 1 && vals.size > 1) return { v: null, ambiguous: true };
      const r = tied.sort((a, b) => a.order - b.order).at(-1);
      return { v: r[prop], from: r };
    };
    const fgw = win("fg"), bgw = win("bg");
    if (fgw.ambiguous || bgw.ambiguous) { bump("同权重跨文件冲突(加载次序静态看不出)"); continue; }
    if (!fgw.v || !bgw.v) { bump("同元素身上凑不齐前景与背景(另一半来自祖先)"); continue; }
    const fgs = fgw.v, bgs = bgw.v;
    // 337 这一层的产出 = **至少有一半不是签名自己那条规则给的**。
    // ⚠ 别写成「fg 与 bg 来自不同规则对象」:同一个选择器写成两条规则(安卓的 .tk-add
    // 就是)会让它在层叠整个退化之后**平凡地**仍然成立 —— 阴性对照当场抓到。
    if (fgw.from.sel !== sig.sel || bgw.from.sel !== sig.sel) crossRule++;
    if (/:(?!not\()[a-z-]/.test(sig.sel)) stateJudged++;

    // 343:生效字号照同一套层叠算。三种情况都落成「不知道」(px === null)——
    //   · 这条链上根本没人写 font-size(继承自祖先,静态定不了)
    //   · 同权重跨文件冲突(与颜色同一条 fail-closed)
    //   · 值不是 px 也不是 --fs-* 令牌(`0.86em` / `clamp(…)`:相对宿主或随视口流动)
    //   · 被一条形状认不出的规则波及(它可能盖着这个签名的字号)
    // 「不知道」= 按 FLOOR 判,与 343 之前逐字相同,并单独计数印出来。
    const fsw = win("fs");
    let px = fsw.ambiguous || !fsw.v ? null : toPx(fsw.v, tok);
    if (px !== null && [...subject.pos].some((a) => fsOpaque.has(a))) px = null;
    const floor = floorFor(px);

    for (const mode of ["light", "dark"]) {
      const bg = toRgb(bgs, tok, mode, varsSeen);
      if (!bg) { bump("背景算不出(渐变 / 图片 / 运行期注入的色)"); continue; }
      if (bg.a < 1) { bump("背景半透明(合成结果取决于底下压着谁)"); continue; }
      const fg = toRgb(fgs, tok, mode, varsSeen);
      if (!fg) { bump("前景算不出"); continue; }
      if (fg.a < 1) { bump("前景半透明"); continue; }
      n++;
      // 字号那三格按**判到的组**数,与上面那些「组」是同一个量纲(按签名数会对不上,
      // 一个签名两档、还可能有一档算不出颜色)
      if (px === null) sizeUnknown++;
      else if (px < SMALL_PX) sizeSmall++;
      else sizeBig++;
      const c = contrast(fg, bg);
      const allow = ALLOW.find((a) => a.source === doc.source && a.file === sig.file && a.selector === sig.sel);
      if (allow) allowHit.add(allow);
      judged.push({
        source: doc.source, doc: doc.name, file: sig.file, selector: sig.sel, mode, fgs, bgs, c,
        px, floor, allowed: !!allow,
      });
      if (c < floor && !allow) {
        problems.push(
          `${where} ${sig.file} ${sig.sel}(${mode === "dark" ? "暗色" : "亮色"}档)对比度 ` +
            `${c.toFixed(2)}:1 < ${floor}` +
            (floor === SMALL_FLOOR
              ? `(字号 ${px}px < ${SMALL_PX}px,按 §2.2 第二条「小字禁止与低对比色叠加」走更高的那条底线)`
              : "") +
            `\n      前景 ${fgs}   背景 ${bgs}\n` +
            `    —— 要么改配色(优先让它走令牌,别写死)` +
            (floor === SMALL_FLOOR ? `,要么把字号抬到 ${SMALL_PX}px 及以上` : "") +
            `,要么在 scripts/check-contrast.mjs 的 ALLOW 里登记并说明为什么`,
        );
      }
    }
  }
  perDoc.set(where, n);
}

// ① 幽灵令牌:引用了哪份令牌表都没有的名字。带兜底 = 静默退回,不带 = 整条声明作废,两种都不响。
for (const name of [...varsSeen].sort()) {
  if (definedVars.has(name)) continue;
  if (RUNTIME_VARS.some((r) => r.name === name)) continue;
  problems.push(
    `幽灵令牌 ${name}:被 CSS 引用,但三份令牌表里都没有它` +
      ` —— 带兜底值会静默退回(判例 --seal-deep),不带兜底整条声明作废(判例 --rule,` +
      `那个输入框从来就没有边框)。要么定义它,要么改成真的令牌,要么它是运行期注入的、` +
      `进 scripts/check-contrast.mjs 的 RUNTIME_VARS 并写明注入点`,
  );
}

// ② 登记表卫生:RUNTIME_VARS 里点名的必须真的被用着(打错字的条目什么都不守)。
for (const r of RUNTIME_VARS) {
  if (!varsSeen.has(r.name)) {
    problems.push(`RUNTIME_VARS 里的 ${r.name} 今天没有任何 CSS 在引用 —— 要么打错了字,要么该删掉`);
  }
  if (definedVars.has(r.name)) {
    problems.push(`${r.name} 登记为「运行期注入」,却在令牌表里也定义了 —— 两个真相源,删一个`);
  }
  if (!r.where?.trim()) problems.push(`RUNTIME_VARS 里的 ${r.name} 没写注入点 —— 空理由 = 没想过`);
}

// ③ ALLOW 卫生:每条都得今天真的命中,且真的低于 FLOOR(否则它是一条过期的免死金牌)。
for (const a of ALLOW) {
  if (!a.why?.trim()) problems.push(`ALLOW 里 ${a.file} ${a.selector} 没写 why —— 空理由 = 没想过,不许过`);
  if (!allowHit.has(a)) {
    problems.push(
      `ALLOW 里 ${a.source} ${a.file} ${a.selector} 今天没被命中` +
        ` —— 选择器改名了 / 规则删了 / 门禁范围变窄了,三种都得当场处理,别留着`,
    );
  } else if (!judged.some((j) => j.selector === a.selector && j.file === a.file && j.c < j.floor)) {
    // ⚠ 比的是**这一组自己那条底线**(343):同一个 4.9:1,在 14px 上是达标、在 12px 上不是。
    // 写死 FLOOR 会让「小字那条底线救下来的登记」在这里被当成过期条目劝删。
    problems.push(
      `ALLOW 里 ${a.source} ${a.file} ${a.selector} 现在两档都已达标 —— 删掉这条登记,别让它继续盖着后来的回退`,
    );
  }
}

// ④ 反向探针:哪个文档都不该判出零组。判据整体失灵时(正则写错、文件搬家)这一条先响,
//    而不是安安静静地全绿。
for (const [name, n] of perDoc) {
  if (n === 0) problems.push(`${name} 一组前后景都没判到 —— 扫描器失灵,不是那里真的没有配色`);
}

// ⑤ 反向探针之二(337):**层叠这一层还在不在**。
//    这道闸失灵的方式是「少判」,而少判是安安静静的绿 —— 谁哪天把 applies() 写回
//    「只认自己那条规则」,hover 这一族就整族退回盲区,门禁一声不吭(336 排队第 1 条
//    就是这么在旧版底下活着的)。所以钉一条**可派生、不写死数字**的下界:
//    「前景与背景来自不同规则」的组数不许归零。
if (crossRule === 0) {
  problems.push(
    "没有任何一组的前景或背景来自**别的**规则 —— 337 加的那层迷你层叠失灵了。" +
      "少判是绿的,所以这一条必须自己响:要么 applies()/win() 被改窄了,要么规则形状变了",
  );
}
if (stateJudged === 0) {
  problems.push(
    "带状态伪类(:hover / :focus / :disabled …)的签名一组都没判到 —— " +
      "hover 这一族正是 337 要盯的那族,它整族消失时必须响,而不是安静地少判",
  );
}

// ⑥ 反向探针之三(338):**文档的样式清单是真算出来的**。
//    css-docs 的模块图遍历失灵时(某种 import 写法没认出来)结果也是「少收一份 CSS」——
//    同样是安静的绿。所以从地面反着核一遍:src/*.css 里每一份都必须至少被一个文档加载到。
//    这条不写死数字,新加一份 CSS 只要真被 import 就自动进来。
for (const f of readdirSync(R("src")).filter((f) => f.endsWith(".css")).map((f) => "src/" + f)) {
  if (!loadedCss.has(f)) {
    problems.push(
      `${f} 没有被任何文档加载到 —— 要么 scripts/lib/css-docs.mjs 的模块图遍历漏了某种 import 写法` +
        `(那它就在安静地少判),要么这份 CSS 今天真的是死文件、该删`,
    );
  }
}

// ⑦ 反向探针之四(338):**分文档这件事还在不在**。
//    ⑥ 守的是「少收」(某份 CSS 谁都没加载)。反方向的「多收」同样安静:模块图遍历退化成
//    「每个文档都收 src 下全部 CSS」之后,层叠算的还是一份大杂烩,判定数甚至更好看,而
//    board.css 的规则会盖到捕获窗的元素上 —— 一条断言都不会红(同 336 ⑩ 刀那族:两个方向
//    都得核)。判据:同一份下的多个文档,**外部样式清单不许两两相同**。
// ⑧ 反向探针之五(338):**DOCS 那张表本身**。它是全脚本唯一写死的东西,而少写一行
//    (比如哪天把捕获窗那条删了)是安静的:剩下的探针一条都不会响。所以拿地面反着核 ——
//    仓里跟踪的每一份 html 要么是一个文档,要么在 NOT_A_DOC 里写明为什么不是。
{
  const tracked = execFileSync("git", ["ls-files", "*.html"], { encoding: "utf8", cwd: R(".") })
    .split("\n").map((s) => s.trim()).filter(Boolean);
  // ⚠ 这一格用**全量**登记表:公开快照上那几份 private 文件不在 tracked 里,两边都不会误报。
  const known = new Set([...DOCS_ALL.map((d) => d.html), ...NOT_A_DOC.map((d) => d.file)]);
  for (const f of tracked) {
    if (!known.has(f)) {
      problems.push(
        `${f} 是仓里的一份 html,却既不在 css-docs 的 DOCS 里、也不在 NOT_A_DOC 里` +
          ` —— 它要么是个该扫的文档(配色一个字都没被看过),要么得写明为什么不是`,
      );
    }
  }
  for (const d of NOT_A_DOC) {
    if (!d.why?.trim()) problems.push(`NOT_A_DOC 里的 ${d.file} 没写 why —— 空理由 = 没想过`);
    // ⚠ `privateOnly` 那几格在**公开快照**上本来就不该在(见上面那段);工作仓里照旧当过期条目逮。
    if (!tracked.includes(d.file) && (IN_WORK_REPO || !d.privateOnly)) {
      problems.push(`NOT_A_DOC 里的 ${d.file} 今天不在仓里 —— 过期条目,删掉`);
    }
  }
}

// ⑨ 反向探针之六(343):**字号这一层还在不在**。
//    它失灵的方式与前几层同族、而且更隐蔽:字号一旦全变成「不知道」,每一组都退回 4.5 判,
//    门禁**照样全绿**,只是那条更严的底线一个字都没落到实处。所以钉两条可派生的下界:
//    ① 至少有一组算出了字号(抓取器 / 令牌解析没整个塌掉);
//    ② 至少有一组落在小字那一档(SMALL_FLOOR 真的管着东西,不是一条从不生效的死规则)。
//    两条都不写死数字 —— 新增一处小字自动进来,少一处也不用改这里。
if (sizeSmall + sizeBig === 0) {
  problems.push(
    "一个签名的字号都没算出来 —— 343 加的那一层失灵了(抓取器认不出写法 / --fs-* 令牌解析不到)。" +
      "字号全变成「不知道」的表现是**全绿**:每一组都退回按 4.5 判,那条更严的底线形同不存在",
  );
}
//    ③ 那条底线本身不许被悄悄放平:`SMALL_FLOOR = FLOOR` 是把这一层原地删掉的最省事写法,
//    而它一条断言都不会红(所有组都退回 4.5,门禁照样绿)。
if (!(SMALL_FLOOR > FLOOR)) {
  problems.push(
    `SMALL_FLOOR(${SMALL_FLOOR})没有严格高过 FLOOR(${FLOOR})—— 那条小字底线等于不存在。` +
      "把红「修」掉的最省事办法就是把它放平,所以这一格自己看着自己(同 check-fs-drift 那道" +
      "「阶下无档」:别从底线那头把规范挖空)",
  );
}
if (sizeSmall === 0) {
  problems.push(
    `没有任何一个签名落在小字那一档(< ${SMALL_PX}px)—— §2.2 第二条那条底线今天一处都没管到。` +
      "要么层叠算字号那一段被改窄了,要么地面上真的一处小字都不剩(那是好事,但得有人当场确认)",
  );
}

for (const source of new Set(docSheets.map((d) => d.source))) {
  const mine = docSheets.filter((d) => d.source === source);
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i].ext, b = mine[j].ext;
      // ⚠ **两边都是空集时不比**(577 加):这道探针的前提是「**模块图遍历**退化成全收」——
      //    而空集的意思是「这份文档压根没有外部样式、全写在页内」,那是 `site/index.html` 那一族的
      //    **常态形**,不是退化(576 之后官网那份下有八个这样的文档,两两相比会给出 28 条假红)。
      // ⛔ 这不开口子:遍历真塌成「什么都收不到」由**探针 ⑥** 逮 —— 它反着问「哪份 src/*.css 谁都
      //    没加载到」,一份也收不到时它会**整排响**。⇒ 这里让掉的只有「本来就没有外部样式」那一格。
      if (a.size === 0 && b.size === 0) continue;
      if (a.size === b.size && [...a].every((f) => b.has(f))) {
        problems.push(
          `${mine[i].where} 与 ${mine[j].where} 加载的外部样式一模一样 —— 同一份下的两个文档` +
            `本该各加载各的(css-docs 的模块图遍历失灵时它们会一起退化成「全收」),` +
            `这时按文档层叠就名存实亡了`,
        );
      }
    }
  }
}

// `--list` 在判定**之前**打印:门禁红着的时候恰恰最想看它到底算出了什么
//(而且外部对拍工装要读它,不能因为退出码非零就拿不到)。
if (process.argv.includes("--list")) {
  for (const j of judged.sort((a, b) => a.c - b.c)) {
    // 字号那一格固定占一列(`?` = 定不出来)—— 对拍工装按多空格切列,别让它变成可有可无的
    // 一段尾巴(338 那次 `--list` 解析歪掉的教训)。
    console.log(
      `${j.c.toFixed(2).padStart(6)}  ${j.mode === "dark" ? "暗" : "亮"}  ${j.px === null ? "?" : j.px}px  ` +
        `${j.source}  ${j.doc}  ${j.file}  ` +
        `${j.selector}\n          前景 ${j.fgs}   背景 ${j.bgs}${j.allowed ? "   [已登记]" : ""}`,
    );
  }
}

if (problems.length) {
  console.error("对比度门禁:不过\n");
  for (const p of problems) console.error("  ✗ " + p);
  console.error(`\n共 ${problems.length} 处。`);
  process.exit(1);
}

const blindTotal = [...blind.values()].reduce((a, b) => a + b, 0);
/** 「离自己那条底线还有多少余量」——小字那一档比的是 7:1,拿 c 直接排会把它排到后面去。 */
const margin = (j) => j.c - j.floor;
const tightest = judged.filter((j) => !j.allowed).sort((a, b) => margin(a) - margin(b))[0];

console.log(
  `对比度门禁通过:${judged.length} 组(每组 = 一个文档里的一个元素签名 × 一档;前后景按同` +
    `元素身上的规则层叠算出)全部达标,` +
    `其中 ${crossRule} 组至少有一半来自别的规则、${stateJudged} 组带状态伪类` +
    `(都是 337 那层层叠的产出),例外 ${ALLOW.length} 条已登记。\n` +
    `  ${perDoc.size} 个文档:` + [...perDoc.entries()].map(([k, v]) => `${k} ${v}`).join(" / ") + "\n" +
    `  字号(343):${sizeSmall} 组小字(< ${SMALL_PX}px)走 §2.2 第二条那条 ${SMALL_FLOOR}:1 的底线、` +
    `${sizeBig} 组不小、**${sizeUnknown} 组字号定不出来**` +
    `(自己那条链上没人写 font-size,继承自祖先 —— 那一格只按 ${FLOOR} 判,是这一层的盲区)\n` +
    `  最紧的一组:${tightest.c.toFixed(2)}:1(底线 ${tightest.floor})  ` +
    `${tightest.source}·${tightest.doc} ${tightest.selector}(${tightest.mode === "dark" ? "暗色" : "亮色"}档)\n` +
    `  判不了的 ${blindTotal} 组(背景来自祖先或半透明,静态定不了):` +
    [...blind.entries()].map(([k, v]) => `${k} ${v}`).join(" / "),
);
