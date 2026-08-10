#!/usr/bin/env node
// 写死颜色的登记门禁(339)——「这一处为什么不走令牌」必须有人当场回答。
//
// # 三道配色门禁的分工
//
//   check-theme-drift    —— 令牌**定义**:三份令牌表逐字对齐(328)
//   check-contrast       —— 令牌**用法**里的可读性:每个元素签名层叠后算 WCAG(336/337/338)
//   本文件               —— 令牌**没被用**的地方:值里直接写死的颜色
//
// 前两道都以「颜色来自令牌」为前提。一处 `color: #fff` 既不在令牌表里(第一道看不见)、
// 又常常压在写死的底上(第二道判得出对比度,但判不出「它本该是令牌」)。328 排队第 4 条、
// 336 排队第 2 条、337 排队第 2 条前半说的都是这一格,一直没人管。
//
// # 判据:不是「不许写死」,是「写死的必须有人签字」
//
// 有些颜色**就该**写死 —— 压在照片上的浮层蒙版、扫码要的白底黑码。判据不是禁止,而是
// 每一处都要在下面的登记表里有一行,写清楚为什么它不随明暗档翻面。两个方向都核:
//   · 扫到的每一处都必须命中某条登记 —— 守「新增一处没人问」
//   · 每条登记都必须至少命中一处   —— 守「颜色早改了、登记还挂着」(过期登记 = 假象)
// 单向核是 336 第 ⑩ 刀判过死刑的形状:那时 `dark: false` 是个没人验的**配置**。
//
// # 扫描面从地面算,不手写
//
// 复用 lib/css-docs.mjs 的 DOCS + sheetsOf(338),与对比度门禁**同一批文件** —— 包括
// 两个 html 壳里的内联 `<style>`。339 当天它就在那里逮到两处:捕获窗的同步状态点抄了
// 第三份绿(sync.css / 这里 / 安卓),空间菜单的浮层投影是全仓 7 处里唯一写死的那个。
//
// # 一处刻意的不对称:桌面逐条、安卓与官网成组
//
// 桌面令牌铺得最全(20 个),写死 = 漂移风险最高,故逐条登记。安卓那份内联 CSS 与官网
// 静态单页没铺阴影/浮层令牌(理由见 check-theme-drift 里 --card-shadow 那条 why),
// 它们那几十处黑色阴影是**同一个理由的同一族**,逐条抄二十遍没有信息量,故按
// (文件, 属性, 颜色形状) 成组登记。代价诚实写在这里:同族里新增一处不会红。
//
// 用法:node scripts/check-hardcoded-colors.mjs [--list]
// 全部登记 = 退出 0;有未登记的 / 有过期登记 / 抓取器自检不过 = 非零响亮。

import { DOCS, sheetsOf } from "./lib/css-docs.mjs";

// ---- 登记表 -------------------------------------------------------------------------
// color 可以是字面串(精确一处)或正则(成组)。file 是 sheetsOf 给的稳定标识。

const OVERLAY_ON_PHOTO =
  "压在**照片**上的浮层,底不是纸面 —— 蒙版与其上的字必须两档都是「深底浅字」。" +
  "换成随明暗翻面的令牌反而错:亮色档下会变成浅蒙版压在深色照片上";

const REGISTERED = [
  // ---- 桌面:逐条 ----
  {
    file: "src/item-images.css",
    prop: "color",
    color: "#fff",
    why: OVERLAY_ON_PHOTO + "(删图钮 / 看大图的错误与加载字 / 左右翻页箭头 / 「图N · i/共」角标)",
  },
  { file: "src/item-images.css", prop: "background", color: /^rgba\((?:34, 31, 25|20, 16, 10), [\d.]+\)$/, why: OVERLAY_ON_PHOTO + "(同上那几处的蒙版底)" },
  {
    file: "src/item-comments.css",
    prop: "background",
    color: "rgba(24, 20, 14, 0.42)",
    why: "留言浮层的遮罩,深压不随档翻面(亮档用浅色压浅色等于没有遮罩)。分野判据(348 拍板):阅读型浮层深压、操作型面板浅雾——留言层是读内容的,深压让身后整版退场好聚焦;设置/同步面板是操作台,浅雾玻璃保住「还在原场所」的方位感。新增浮层按此二选一,别再各拍各的——settings/sync 的浅雾是操作型那一路,不与本条矛盾",
  },
  {
    file: "src/sync.css",
    prop: "background",
    color: "#c9973a",
    why: "同步状态点的「连接中 / 初始同步」琥珀。纸墨朱三色里没有「中性等待」这一格,而它不能用 --seal(那是 .err,两态得一眼分得开)。与 --ok 不同,安卓那端用的是朱砂淡,两端本就不是同一个表达,没有「一个语义两个值」的漂移可消",
  },
  { file: "index.html#style", prop: "background", color: "#c9973a", why: "同上 —— 捕获窗空间选择器里的同一枚状态点(同一份规则的第二个宿主)" },
  {
    file: "src/sync.css",
    prop: "background",
    color: "#fff",
    why: "配对二维码的底(107)。恒白底黑码:扫码要的是相机看到的对比度,跟着暗色档翻面会让手机扫不出来",
  },
  {
    file: "src/topics.css",
    prop: "background",
    color: "#000",
    why: "合并条「比纸面沉一档」的底座,两档同向往暗压。与 337 那条「hover 不许往 #000 压」不冲突:那条要的是「离纸面更远、更凸出」故须翻面,这里要的是绝对的沉。详见 topics.css 那处的注释",
  },
  {
    file: "src/controls.css",
    prop: "box-shadow",
    color: "#fff",
    why: "四个视图标题前那枚朱砂方印的受光内高光。它压在 --seal 上(不是纸面),朱砂两档都是暖红,故白高光两档都成立。339 之前这一句在 board/inbox/search/topics 各抄一份,同轮抽进共享件 `.view header h1::before`",
  },

  // ---- 安卓 / 官网:成组(理由见头部「一处刻意的不对称」) ----
  {
    file: "android/index.html#style",
    prop: /^(box-shadow|text-shadow|background)$/,
    color: /^rgba\(0, 0, 0, [\d.]+\)$/,
    why: "安卓那份没铺 --card-shadow/--float-shadow(见 check-theme-drift 里那条 why:小屏上投影会糊成一片,卡片改用发丝线描边),剩下的投影与遮罩都是就地写的黑",
  },
  { file: "android/index.html#style", prop: "color", color: "#fff", why: OVERLAY_ON_PHOTO + "(安卓看大图那一套:角标 / 关闭钮 / 计数)" },
  { file: "android/index.html#style", prop: /^(border|box-shadow)$/, color: /^rgba\(255, 255, 255, [\d.]+\)$/, why: "同上那批深色蒙版上的描边 —— 底是照片,故用白而不是 --line" },
  {
    file: "site/index.html#style",
    prop: "box-shadow",
    color: /^rgba\((?:40,30,18|255,255,255),\s*\.?[\d.]+\)$/,
    why: "官网单页的投影。它有 --card-shadow/--float-shadow,但这三处是版面级的大投影(截图卡 / 下载按钮),值与那两个令牌都不同;官网是静态单页、不参与 app 的层次体系",
  },
  {
    file: "site/index.html#style",
    prop: /^(-webkit-)?mask-image$/,
    color: "#000",
    why: "遮罩通道值,不是颜色 —— mask 只读它的 alpha,黑=不透明。写 var(--ink) 反而会让遮罩强度随明暗档乱变",
  },
];

// ---- 抓取 ---------------------------------------------------------------------------

const COLOR =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|(?<![-\w])(?:white|black|red|blue|green|gray|grey|silver|yellow|orange|purple|pink|brown|navy|teal|olive|maroon|lime|aqua|fuchsia)(?![-\w])/gi;

/**
 * 一份样式里全部**值位置**的写死颜色。
 * 只在最内层 `{…}` 块体里找声明 —— 选择器(`#cap-cmd`、`a:hover`)因此天然不参与,
 * @media 之类的嵌套也天然只在最里面那层命中。
 */
export function scan(raw) {
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const hits = [];
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    for (const d of block[1].matchAll(/(^|;)\s*(-?[-\w]+)\s*:\s*([^;]*)/g)) {
      const prop = d[2];
      if (prop.startsWith("--")) continue; // 令牌定义处 —— 那是它该待的地方
      const value = d[3].replace(/\burl\([^)]*\)/g, " "); // data-uri 里的 # 不是颜色
      for (const m of value.matchAll(COLOR)) {
        const at = block.index + 1 + d.index + d[0].indexOf(d[3]) + m.index;
        hits.push({ line: text.slice(0, at).split("\n").length, prop, color: m[0] });
      }
    }
  }
  return hits;
}

// ---- 抓取器自检 ---------------------------------------------------------------------
// 少抓 = 少判 = 安静的绿(337 第 ⑤ 刀、338 探针 ⑥ 那一族)。这段样本自带,不随仓库变,
// 每种该抓的写法与每种该跳过的形状各一处;抓到的必须**恰好等于**期望,多一条少一条都红。

const SELFTEST_CSS = `
  :root { --tok: #abc; --other: rgba(1, 2, 3, 0.4); }
  .a { color: #fff; background: rgb(1, 2, 3); border-color: hsl(0, 0%, 0%); }
  .b { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), inset 0 0 0 1px #11223344; }
  .c { white-space: nowrap; border-color: currentColor; background: transparent; }
  .d { background: url("data:image/svg+xml,%3Csvg fill='%23ff0000'%3E"); }
  .e { color: red; }
  /* .f { color: #dead00; } 注释里的不算 */
  #fff .g:hover { outline-color: var(--tok); }
  @media (prefers-color-scheme: dark) { .h { color: #000; } }
`;
const SELFTEST_EXPECT = [
  "color:#fff",
  "background:rgb(1, 2, 3)",
  "border-color:hsl(0, 0%, 0%)",
  "box-shadow:rgba(0, 0, 0, 0.5)",
  "box-shadow:#11223344",
  "color:red",
  "color:#000",
];

function selfTest() {
  const got = scan(SELFTEST_CSS).map((h) => `${h.prop}:${h.color}`);
  const a = JSON.stringify(got);
  const b = JSON.stringify(SELFTEST_EXPECT);
  if (a !== b) {
    console.error("✗ 抓取器自检不过 —— 在核仓库之前它自己就已经算错了。");
    console.error("  期望:", b);
    console.error("  实得:", a);
    process.exit(2);
  }
}

// ---- 主 -----------------------------------------------------------------------------

const match = (pat, s) => (pat instanceof RegExp ? pat.test(s) : pat === s);

function main() {
  selfTest();
  const listOnly = process.argv.includes("--list");

  // 同一份 CSS 会被多个文档加载(theme.css 四个文档都加载)。写死颜色是**文件**的属性、
  // 不是文档的,故按文件去重 —— 否则同一行会被数四遍。
  const files = new Map();
  for (const doc of DOCS) for (const s of sheetsOf(doc)) files.set(s.file, s.text);

  const hits = [];
  for (const [file, text] of files) for (const h of scan(text)) hits.push({ file, ...h });

  const used = new Set();
  const orphans = [];
  for (const h of hits) {
    const i = REGISTERED.findIndex(
      (r) => match(r.file, h.file) && match(r.prop, h.prop) && match(r.color, h.color),
    );
    if (i === -1) orphans.push(h);
    else used.add(i);
  }
  const stale = REGISTERED.filter((_, i) => !used.has(i));

  if (listOnly) {
    for (const h of hits) console.log(`${h.file}  ${h.line}  ${h.prop}  ${h.color}`);
    return;
  }

  let bad = false;
  if (orphans.length) {
    bad = true;
    console.error(`✗ ${orphans.length} 处写死颜色没有登记 —— 每一处都要回答「为什么它不走令牌」:`);
    for (const h of orphans) console.error(`    ${h.file}:${h.line}  ${h.prop}: ${h.color}`);
    console.error("  站得住就往 REGISTERED 加一行写明理由;站不住就换成 var(--…)。");
  }
  if (stale.length) {
    bad = true;
    console.error(`✗ ${stale.length} 条登记一处都没命中 —— 颜色改掉了而登记还挂着(过期登记 = 假象):`);
    for (const r of stale) console.error(`    ${r.file}  ${r.prop}  ${r.color}`);
  }
  if (bad) process.exit(1);

  const byFile = new Map();
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
  console.log(
    `写死颜色门禁通过:${hits.length} 处全部登记在案(${REGISTERED.length} 条登记,` +
      `扫 ${files.size} 份样式 / ${DOCS.length} 个文档)。`,
  );
  console.log(
    "  分布:" + [...byFile].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(" / "),
  );
  console.log(
    "  ⚠ 成组登记(安卓 / 官网)里新增同族的一处不会红 —— 那是刻意的取舍,理由见文件头。",
  );
}

main();
