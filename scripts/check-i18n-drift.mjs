#!/usr/bin/env node
// 文案出处门禁(358,i18n-plan §2)。前八道管样式/时长/几何/逻辑,这道管**文案**:
// 用户可见中文必须走字典(zh/en 并排),不许再写死在代码与壳里。
//
// **三个工程各扫一遍**(360 第③笔起):桌面 = src/ + 两个窗口壳,安卓 = android/src/ +
// 一个壳,官网 = site/index.html 一份(壳与字典同一个文件)。三边各有一份独立字典(互不
// 共享代码的三份产物,同 theme/timing/filter 那族),键空间彼此独立;必须说同一句话的那
// 几枚键由 CROSS_END_KEYS 恰等登记。
//
// 官网没有构建步骤(静态单文件 scp 部署,deploy §8),故字典与运行期内联在那个 html 里:
// **形状与两个客户端的分片一字对齐**,同一条 ENTRY_LINE 解析,只是取块的方式不同(标记
// 对之间 vs 整份文件)。360 之前它只按「含 CJK 的行数」挂账(PENDING),那是个只数行数
// 的粗账 —— 现在它进正扫描面,判据与另两个工程逐条相同,账本随之退役。
//
// # 判据(两个方向都核)
//
//  ① 工程内 **/*.ts(字典分片自身除外)的字符串/模板串里出现 CJK → 红;豁免两类:
//     (a) `new Error(…)`(throw 与 reject 两形)/ `console.*(…)` 的诊断串(受众=开发者,
//         与「Rust 侧 4500+ 串不翻」同一条线,豁免**计数印在输出里**);
//     (b) STRING_REGISTRY 逐值签字。登记了没命中也红。
//  ② 窗口壳(notebook.html / index.html / android/index.html):CJK 只许出现在挂了
//     data-i18n(-title/-aria-label/-placeholder)的元素文本/属性里,且**原文与 zh 字典
//     逐字相等**(markup 保留中文防首帧闪,163 契约——相等由这里核,不靠人记「改一处改
//     另一处」);data-i18n 元素不得有子元素(textContent 覆写会吞掉 svg)。
//  ③ 键双向(逐工程):代码 t("…") 字面量 + 壳 data-i18n* 用到的键必须在本工程字典;
//     字典每键必须有人用。动态键(t 后面不是字符串字面量)逐处进 DYNAMIC_T 签字,恰等。
//  ④ 每键 zh/en 的 {占位符} 集合必须相等(静态抓「en 忘写占位符」这类运行期才炸的病)。
//  ⑤ en 值出现 CJK → EN_CJK_REGISTRY 签字(如语言名「中文」按惯例不翻)。
//  ⑥ 分片形状闸:一键一行、双引号——不合形即红(否则本门禁解析不了 = 安静的绿);
//     分片文件必须逐一 import 进 locales/index.ts 并 spread(漏一半即红)。内联字典同形,
//     另加「标记恰一对」(找不到 / 多一对一律抛,别猜边界)。
//  ⑦ SHELL_REGISTRY:壳里刻意不进字典的 CJK(字体名、印文),**逐值带命中处数**签字——
//     只写值不写数就等于「这个字随便哪儿出现都放行」,那是给自己开的后门。
//  ⑧ 工程内 *.css 不许出现注释外 CJK(今天 0 处,出现即红)。
//  ⑨ CROSS_END_KEYS:两端必须说同一句话的键(筛选 pill 那族——check-filter-parity 的
//     期望表钉着它们),逐键核「两边都有 ∧ zh 逐字相等 ∧ en 逐字相等」,两个方向都核。
//  ⑩ 属性绑定表不是登记表:官网支持哪几个 data-i18n-* 从它自己那段运行期的 BIND 表里
//     读(读不动就抛),不另写一份没人核的清单(336 ⑩ 刀的判例)。
//
// 用法:node scripts/check-i18n-drift.mjs
// 全过 = 退出 0;违例 / 键漂移 / 账本不齐 / 看不懂的形状 = 非零响亮。发版门禁之一。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- 工程表 -------------------------------------------------------------------------

/**
 * 三份互不共享代码的产物,各自一份字典、一套壳。**键空间彼此独立**——都可以有
 * `topics.header`,值不必相同(手机与桌面的话术本就不同);必须相同的那几枚走
 * CROSS_END_KEYS。物理上合不成一份的理由与 theme/timing/filter 那族同源(独立工程 /
 * 静态单文件),只是这份是纯数据、由门禁而不是 import 保对齐。
 *
 * `dict` 说字典从哪儿来:`shards` = locales/ 目录逐分片;`inline` = 壳里那对标记之间
 * (官网无构建步骤)。`ts`/`css` 为 null = 这个工程没有那一面(官网的样式内联在壳里,
 * 由判据②盖住;它也没有任何 TS)。
 */
const PROJECTS = [
  { label: "桌面", dict: { kind: "shards", dir: "src/locales" }, ts: "src", css: "src", shells: ["notebook.html", "index.html"] },
  { label: "安卓", dict: { kind: "shards", dir: "android/src/locales" }, ts: "android/src", css: null, shells: ["android/index.html"] },
  { label: "官网", dict: { kind: "inline", file: "site/index.html" }, ts: null, css: null, shells: ["site/index.html"] },
];

// ---- 登记表 -------------------------------------------------------------------------

/** ①(b):TS 里刻意保留的中文串,逐文件逐值签字;登记了没命中也红。 */
const STRING_REGISTRY = [
  { file: "src/update.ts", value: "朱简", why: "meaningfulNotes 剥版本噪音的匹配字面量(对 CI 历史 notes 文本),不是显示文案,翻了会破坏判据" },
  { file: "src/update.ts", value: "安卓版", why: "同上,meaningfulNotes 的匹配字面量" },
  { file: "android/src/main.ts", value: "朱简", why: "同桌面 update.ts:安卓更新提示条剥版本噪音的匹配字面量" },
  { file: "android/src/main.ts", value: "安卓版", why: "同上" },
  { file: "src/sync.ts", value: "同步席位已满", why: "后端 err_code::SEAT_LIMIT 那句人话的判别片段(Rust 诊断不翻),用来把「请先移除一台不用的设备」接进设备名单入口(identity-plan §5.8);匹配字面量不是显示文案,翻了会破坏判据" },
  { file: "android/src/sync.ts", value: "同步席位已满", why: "同桌面 sync.ts:安卓侧同一条判别片段" },
];

/** ③:t() 后面不是字符串字面量的调用点,按文件恰等计数。 */
const DYNAMIC_T = [
  { file: "src/i18n.ts", count: 4, why: "applyStaticI18n 的四类 data-i18n* 属性取键;键集由壳扫描侧(判据②③)覆盖" },
  { file: "android/src/i18n.ts", count: 4, why: "同上,安卓孪生" },
];

/** ⑤:en 值里刻意保留 CJK 的键(按分片文件签字——各端同名键各签各的)。 */
const EN_CJK_REGISTRY = [
  { file: "src/locales/settings.ts", key: "settings.langZh", why: "语言名按惯例显自己那门语言:en 档也显「中文」" },
  { file: "android/src/locales/settings.ts", key: "settings.langZh", why: "同上,安卓孪生" },
  { file: "site/index.html", key: "nav.langToggle", why: "官网的语言开关显**另一门**语言的名字:en 档上写「中文」正是它要去的地方" },
];

/**
 * ⑦:壳里刻意不进字典的 CJK。**必须带命中处数**——只签字不数数等于「这个字随便哪儿
 * 出现都放行」,而「朱」在这份文件里既是印文也是正文(朱简 / 朱砂 / 朱墨),那样的登记
 * 会把三处真文案一起放走。故值取到能唯一定位的上下文,并逐条恰等对数。
 */
const SHELL_REGISTRY = [
  { file: "site/index.html", value: '"楷体"', count: 1, why: "--font-brush 字体栈里的字体名 —— 是 CSS 值不是文案;三份令牌表逐字对齐由 check-theme-drift 核" },
  { file: "site/index.html", value: ">朱</text>", count: 2, why: "朱砂方印的印文(单字印 + 双字印各一)。印是品牌标记,两档都是这一个字" },
  { file: "site/index.html", value: ">简</text>", count: 1, why: "同上,双字印的第二字" },
];

/**
 * ⑨:两端必须逐字说同一句话的键。今天只有筛选 pill 那族——check-filter-parity 把两端
 * 筛选函数体切出来对拍,期望表钉的就是这几枚 pill 的中文标签;两份字典在这里漂了,那道
 * 闸会红,但它说不清是逻辑漂了还是文案漂了,故在这里先钉一遍。两个方向都核:登记的键
 * 两边都要有(缺一边即红)、值 zh/en 都要逐字相等。
 * ⚠ 桌面另有 filter.pillTitle / collapseKids / expandKids 三枚 hover 提示键——触屏没有
 *   hover,安卓压根没有对应 UI,故**不在**共有集里(登记表只列真该相同的)。
 */
const CROSS_END_PROJECTS = ["桌面", "安卓"]; // 官网不在其中:营销页另一套话术,没有筛选 pill
const CROSS_END_KEYS = [
  { key: "filter.all", why: "「所有」pill,parity 闸 RENDER/CLICK 用例钉着它" },
  { key: "filter.none", why: "「无标签」pill,同上" },
  { key: "filter.thatTag", why: "死标签占位,parity 闸 LABEL_CASES 钉着它" },
  { key: "filter.kindAxis", why: "类型轴标题,parity 闸 KINDROW_CASES 的行首" },
  { key: "filter.allKinds", why: "「全部类型」pill,同上" },
];

/*
 * 挂账表(PENDING)已随第③笔销账、整只删除:安卓 359 进正扫描面,官网 360 进正扫描面,
 * 三个工程从此判据相同。别再加回来 —— 它是按「含 CJK 的行数」记的粗账,只答得出「有没有
 * 变多」,答不出「这一行是不是文案」。
 */

// ---- TS 词法:注释外提取字符串(含模板串字面段),并给出「串已挖空」的代码 ----------

/**
 * fail-closed 到能 fail 的程度:引号/反引号/块注释不配平一律抛。正则字面量按
 * 「前一个非空白字符 ∈ 起始集」的惯用启发式识别(否则 /["']/ 这类会把词法带偏,
 * 抓取器自检里钉了一条)。
 */
function lexTs(src, rel) {
  const n = src.length;
  const strings = []; // {raw, start, line, tpl}
  const out = src.split(""); // blanked 副本:注释/串内容/模板字面段挖空,**代码结构保留**
  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (at) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const blankRange = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let lastMeaning = ""; // 上一个非空白的「有意义」字符,供正则启发式

  // 模板表达式 ${…} 递归回代码态:第一版把表达式整段挖空,`innerHTML 模板里的
  // ${t("…")}` 全成了门禁盲区(键被误判「存而不用」),别退回去。
  function lexCode(i, inExpr) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        const e = src.indexOf("\n", i);
        const stop = e === -1 ? n : e;
        blankRange(i, stop);
        i = stop;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const e = src.indexOf("*/", i + 2);
        if (e === -1) throw new Error(`${rel}:块注释没配平 —— 词法看不懂`);
        blankRange(i, e + 2);
        i = e + 2;
        continue;
      }
      if (c === "/" && /[(,=:[!&|?{;\n+]|^$|return$/.test(lastMeaning)) {
        // 正则字面量:跳到未转义的 /(尊重 [...] 字符类)
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const d = src[j];
          if (d === "\\") j += 2;
          else if (d === "[") (inClass = true), j++;
          else if (d === "]") (inClass = false), j++;
          else if (d === "/" && !inClass) break;
          else if (d === "\n") throw new Error(`${rel}:${lineOf(i)} 行疑似正则字面量断行 —— 词法看不懂`);
          else j++;
        }
        blankRange(i, j + 1);
        i = j + 1;
        lastMeaning = "re";
        continue;
      }
      if (c === '"' || c === "'") {
        const start = i;
        i++;
        let raw = "";
        while (i < n && src[i] !== c) {
          if (src[i] === "\n") throw new Error(`${rel}:${lineOf(start)} 行字符串断行没配平 —— 词法看不懂`);
          if (src[i] === "\\") {
            raw += src[i] + (src[i + 1] ?? "");
            i += 2;
          } else {
            raw += src[i];
            i++;
          }
        }
        if (i >= n) throw new Error(`${rel}:${lineOf(start)} 行字符串没配平 —— 词法看不懂`);
        blankRange(start + 1, i);
        i++;
        strings.push({ raw, start, line: lineOf(start), tpl: false });
        lastMeaning = '"';
        continue;
      }
      if (c === "`") {
        i = lexTemplate(i);
        lastMeaning = "`";
        continue;
      }
      if (inExpr) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return i; // 停在配平的 } 上,交还模板扫描
          depth--;
        }
      }
      if (!/\s/.test(c)) lastMeaning = c === "n" && src.slice(i - 5, i + 1).endsWith("return") ? "return" : c;
      i++;
    }
    if (inExpr) throw new Error(`${rel}:模板表达式的 { 没配平 —— 词法看不懂`);
    return i;
  }

  function lexTemplate(i) {
    const tplStart = i; // src[i] === "`"
    i++;
    let chunkStart = i;
    const pushChunk = (a, b) => {
      strings.push({ raw: src.slice(a, b), start: a, line: lineOf(a), tpl: true });
      blankRange(a, b);
    };
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        pushChunk(chunkStart, i);
        return i + 1;
      }
      if (c === "$" && src[i + 1] === "{") {
        pushChunk(chunkStart, i);
        i = lexCode(i + 2, true) + 1; // 表达式递归回代码态,越过配平的 }
        chunkStart = i;
        continue;
      }
      i++;
    }
    throw new Error(`${rel}:${lineOf(tplStart)} 行模板串没配平 —— 词法看不懂`);
  }

  lexCode(0, false);
  return { strings, blanked: out.join("") };
}

const CJK = /[㐀-鿿]/;

/** ①(a) 诊断豁免:串**确实住在** new Error(…) / console.*(…) 的实参里才算(throw 与
 *  reject(new Error(…)) 两形都盖住——这类串 catch 后不上屏,受众是开发者)。判法 =
 *  串起始位往前 200 字内找最近的开括号标记,且到串为止那只括号还没配平;按行回看
 *  的第一版在自检里就误伤了「上两行恰有 console.error 的普通串」,别退回去。 */
function isDiagnostic(src, start) {
  const before = src.slice(Math.max(0, start - 200), start);
  const m = [...before.matchAll(/(?:\bnew Error|console\.\w+)\(/g)].pop();
  if (!m) return false;
  let depth = 1;
  for (const ch of before.slice(m.index + m[0].length)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth >= 1;
}

// ---- 字典分片解析(判据⑥的形状闸) --------------------------------------------------

const ENTRY_LINE =
  /^\s*"([A-Za-z0-9.]+)"\s*:\s*\{\s*zh\s*:\s*"((?:[^"\\\n]|\\.)*)"\s*,\s*en\s*:\s*"((?:[^"\\\n]|\\.)*)"\s*\}\s*,\s*$/;
const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const BOILERPLATE = /^\s*$|^\s*\/\/|^import |^export const \w+ = defineMessages\(\{$|^\}\);$/;

function unq(s, where) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    throw new Error(`${where} 的转义 JSON.parse 不了:${s}`);
  }
}

function parsePart(rel, errs) {
  const src = readFileSync(resolve(root, rel), "utf8");
  const entries = new Map(); // key -> {zh, en, line}
  src.split("\n").forEach((line, idx) => {
    if (BOILERPLATE.test(line)) return;
    const m = ENTRY_LINE.exec(line);
    if (!m) {
      errs.push(`${rel}:${idx + 1} 不合分片形(一键一行、双引号、无模板串):${line.trim().slice(0, 60)}`);
      return;
    }
    const [, key, zhRaw, enRaw] = m;
    if (!KEY_SHAPE.test(key)) errs.push(`${rel}:${idx + 1} 键名不合形(camelCase 点分段):${key}`);
    if (entries.has(key)) errs.push(`${rel}:${idx + 1} 分片内重键:${key}`);
    entries.set(key, { zh: unq(zhRaw, `${rel}:${idx + 1} zh`), en: unq(enRaw, `${rel}:${idx + 1} en`), line: idx + 1 });
  });
  return entries;
}

// ---- html 壳解析(判据②) -----------------------------------------------------------

/** 两个客户端工程的绑定表 = src/i18n.ts 与 android/src/i18n.ts 里 applyStaticI18n 的那三行。 */
const ATTR_BINDINGS = [
  ["data-i18n-title", "title"],
  ["data-i18n-aria-label", "aria-label"],
  ["data-i18n-placeholder", "placeholder"],
];

/**
 * ⑩ 官网那份**从它自己的运行期读**(内联脚本里的 `var BIND = {…}`),不另写登记表:
 * 手写一份「官网支持哪几个 data-i18n-*」和 336 ⑩ 刀判过死刑的 `dark: false` 是同一种
 * 东西 —— 那句登记本身没人核,改错了照样绿。读不动 / 有看不懂的项一律抛。
 */
function parseBindings(rel) {
  const raw = readFileSync(resolve(root, rel), "utf8");
  const m = /\bvar BIND = \{([^}]*)\};/.exec(raw);
  if (!m) throw new Error(`${rel} 读不到内联的 BIND 绑定表 —— 门禁不猜本页支持哪几个 data-i18n-*`);
  const pairs = [...m[1].matchAll(/"(data-i18n-[a-z-]+)"\s*:\s*"([a-z-]+)"/g)].map((x) => [x[1], x[2]]);
  const leftover = m[1].replace(/"(data-i18n-[a-z-]+)"\s*:\s*"([a-z-]+)"\s*,?/g, "").trim();
  if (!pairs.length || leftover) throw new Error(`${rel} 的 BIND 表里有看不懂的项(抓到 ${pairs.length} 条,剩余「${leftover}」)`);
  return pairs;
}

/** 内联字典的取块标记(官网)。恰一对,找不到 / 多一对一律抛 —— 边界猜不得。 */
const DICT_OPEN = "⟦i18n-dict⟧";
const DICT_CLOSE = "⟦/i18n-dict⟧";

/**
 * 解析壳里那段内联字典,返回 {entries, mask}。mask = 「这一段在壳扫描里当注释挖空」的
 * 字符区间:字典的 zh 值当然全是中文,不挖空就成了判据②的一片假红。
 */
function parseInlineDict(rel, errs) {
  const raw = readFileSync(resolve(root, rel), "utf8");
  const hits = (needle) => [...raw.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((m) => m.index);
  const opens = hits(DICT_OPEN); // ⟦…⟧ 与 ⟦/…⟧ 不互相误命中(开标记要求 ⟦ 后紧跟 i)
  const closes = hits(DICT_CLOSE);
  if (opens.length !== 1 || closes.length !== 1 || closes[0] < opens[0]) {
    throw new Error(`${rel} 的内联字典标记不是恰一对(${DICT_OPEN} ${opens.length} 处 / ${DICT_CLOSE} ${closes.length} 处)`);
  }
  const lineStart = (at) => raw.lastIndexOf("\n", at) + 1;
  const lineEnd = (at) => {
    const e = raw.indexOf("\n", at);
    return e === -1 ? raw.length : e;
  };
  const mask = { start: lineStart(opens[0]), end: lineEnd(closes[0]) };
  const before = raw.slice(0, lineEnd(opens[0]) + 1);
  const firstLine = before.split("\n").length; // 标记行之后的第一行
  const body = raw.slice(lineEnd(opens[0]) + 1, lineStart(closes[0]));
  const entries = new Map();
  body.split("\n").forEach((line, idx) => {
    if (/^\s*$/.test(line) || /^\s*\/\*.*\*\/\s*$/.test(line)) return;
    const m = ENTRY_LINE.exec(line);
    if (!m) {
      errs.push(`${rel}:${firstLine + idx} 不合字典形(一键一行、双引号、无模板串):${line.trim().slice(0, 60)}`);
      return;
    }
    const [, key, zhRaw, enRaw] = m;
    const where = `${rel}:${firstLine + idx}`;
    if (!KEY_SHAPE.test(key)) errs.push(`${where} 键名不合形(camelCase 点分段):${key}`);
    if (entries.has(key)) errs.push(`${where} 字典内重键:${key}`);
    entries.set(key, { zh: unq(zhRaw, `${where} zh`), en: unq(enRaw, `${where} en`), line: firstLine + idx });
  });
  return { entries, mask };
}

/**
 * ⚠ 前导必须是空白,不能用 `\b`:`\bcontent="` 会从 `data-i18n-content="meta.desc"` 的
 * 尾巴上命中(`-` 是非词字符,`\b` 在那儿成立),于是 `<meta>` 的真 content 取成了键名。
 * 360 第一版就栽在这儿 —— 属性名互为后缀时,词边界不是边界。
 */
function attrOf(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/**
 * 返回 {usedKeys: Map key->[where], sanctioned: [{start,end}], errs 追加}。
 * sanctioned = 「许可出现 CJK 的区间」:绑了键的元素文本与属性值(与 zh 字典逐字核过)。
 */
function scanShell(rel, dict, usedKeys, errs, opts = {}) {
  const bindings = opts.bindings ?? ATTR_BINDINGS;
  const raw = readFileSync(resolve(root, rel), "utf8");
  // 注释挖空:html 注释 + 内联 <style>/<script> 里的块注释(壳里注释全是中文,不是文案)
  let src = raw.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, " ")).replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
  // 内联字典段同样挖空(它的 zh 值当然全是中文;由 parseInlineDict 单独逐行核过形状)
  if (opts.mask) {
    const { start, end } = opts.mask;
    src = src.slice(0, start) + src.slice(start, end).replace(/[^\n]/g, " ") + src.slice(end);
  }
  const sanctioned = [];
  // ⑦ 登记表签字的那几处:值取到能唯一定位的上下文,处数恰等(见 SHELL_REGISTRY 注)
  for (const r of SHELL_REGISTRY.filter((x) => x.file === rel)) {
    let at = -1;
    let n = 0;
    while ((at = src.indexOf(r.value, at + 1)) !== -1) {
      sanctioned.push({ start: at, end: at + r.value.length });
      n++;
    }
    if (n !== r.count) errs.push(`SHELL_REGISTRY 处数漂移:${rel}「${r.value}」登记 ${r.count} / 实际 ${n}(改掉了就删这行;多了就是新写死)`);
  }
  const lineOf = (at) => src.slice(0, at).split("\n").length;
  const use = (key, where) => {
    if (!usedKeys.has(key)) usedKeys.set(key, []);
    usedKeys.get(key).push(where);
  };

  for (const m of src.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    const tagEnd = m.index + tag.length;
    const where = `${rel}:${lineOf(m.index)}`;

    const textKey = attrOf(tag, "data-i18n");
    if (textKey !== null) {
      use(textKey, where);
      const close = src.indexOf("<", tagEnd);
      const content = src.slice(tagEnd, close === -1 ? src.length : close);
      if (close !== -1 && src[close + 1] !== "/") {
        errs.push(`${where} data-i18n 元素带子元素(textContent 覆写会吞掉它):${tag.slice(0, 50)}`);
      }
      const entry = dict.get(textKey);
      if (entry && content.trim() !== entry.zh.trim()) {
        errs.push(`${where} data-i18n="${textKey}" 的原文与 zh 字典漂移:壳「${content.trim()}」/ 字典「${entry.zh}」`);
      }
      sanctioned.push({ start: tagEnd, end: close === -1 ? src.length : close });
    }
    for (const [binding, target] of bindings) {
      const key = attrOf(tag, binding);
      if (key === null) continue;
      use(key, where);
      const val = attrOf(tag, target);
      if (val === null) {
        errs.push(`${where} 挂了 ${binding} 却没有 ${target} 属性(壳里要留 zh 原文防首帧闪)`);
        continue;
      }
      const entry = dict.get(key);
      if (entry && val !== entry.zh) {
        errs.push(`${where} ${binding}="${key}" 的 ${target} 原文与 zh 字典漂移:壳「${val}」/ 字典「${entry.zh}」`);
      }
      const at = src.indexOf(`${target}="${val}"`, m.index);
      sanctioned.push({ start: at, end: at + target.length + 2 + val.length + 1 });
    }
  }

  const badLines = new Map(); // line -> 首个样本(逐字符报太吵,按行收拢)
  for (const m of src.matchAll(new RegExp(CJK.source, "g"))) {
    const at = m.index;
    if (!sanctioned.some((s) => at >= s.start && at < s.end)) {
      const line = lineOf(at);
      if (!badLines.has(line)) badLines.set(line, src.slice(Math.max(0, at - 12), at + 12).replace(/\n/g, " "));
    }
  }
  for (const [line, sample] of badLines) errs.push(`${rel}:${line} 出现未绑 data-i18n 的中文:…${sample}…`);
}

// ---- 文件枚举 -----------------------------------------------------------------------

function walkDir(rel, exts) {
  const out = [];
  const go = (d) => {
    for (const name of readdirSync(resolve(root, d))) {
      const p = join(d, name);
      if (statSync(resolve(root, p)).isDirectory()) go(p);
      else if (exts.some((e) => name.endsWith(e))) out.push(p.replace(/\\/g, "/"));
    }
  };
  go(rel);
  return out;
}

// ---- 抓取器自检 ---------------------------------------------------------------------
// 不随仓库变的样本:该抓/该跳的每种形状各钉一条,抓到的必须恰好等于期望(照 340 的做法)。

function selfCheck() {
  const sample = [
    `// 注释里的中文不算`,
    `const a = "中文一";`,
    `const b = '中文二';`,
    "const c = `中文三 ${x} 尾巴`;",
    `throw new Error("诊断不算");`,
    `console.error("也不算");`,
    `reject(new Error("这形也不算"));`,
    `const re = /["']/; const d = "中文四";`,
    `const e = "english";`,
    `t("a.b"); t(dyn);`,
    "const f = `${t(\"n.k\")} 后缀`;",
  ].join("\n");
  const { strings, blanked } = lexTs(sample, "self-check");
  const hits = [];
  let diag = 0;
  for (const s of strings) {
    if (!CJK.test(s.raw)) continue;
    if (isDiagnostic(sample, s.start)) diag++;
    else hits.push(s.raw);
  }
  const want = "中文一|中文二|中文三 | 尾巴|中文四| 后缀";
  if (hits.join("|") !== want) throw new Error(`自检:抓到 [${hits.join("|")}],期望 [${want}]`);
  if (diag !== 3) throw new Error(`自检:诊断豁免数 ${diag},期望 3`);
  const lits = [...blanked.matchAll(/\bt\(\s*"/g)];
  const dyn = [...blanked.matchAll(/(?<!function )\bt\(\s*[^"\s)]/g)].length;
  // 字面 2 = 顶层 t("a.b") + 模板表达式里的 t("n.k")(后者是递归回代码态挣来的,见 lexTs 注)
  if (lits.length !== 2 || dyn !== 1) throw new Error(`自检:t 调用点 字面 ${lits.length}/动态 ${dyn},期望 2/1`);
  for (const [li, wantKey] of [[0, "a.b"], [1, "n.k"]]) {
    const qAt = lits[li].index + lits[li][0].length - 1;
    const mapped = strings.find((s) => s.start === qAt);
    if (!mapped || mapped.raw !== wantKey) throw new Error(`自检:t 字面量位置对账失败(抓到 ${mapped?.raw},期望 ${wantKey})`);
  }

  if (!ENTRY_LINE.test('  "a.bC": { zh: "中「\\"引\\"」文", en: "ok" },')) throw new Error("自检:合形条目行没认出");
  for (const bad of ['  "a.b": { zh: `模板`, en: "x" },', "  \"a.b\": { zh: '单引号', en: 'x' },", '  "a.b": { zh: "x", en: "y" }, // 行尾注释']) {
    if (ENTRY_LINE.test(bad)) throw new Error(`自检:坏形状被认成了条目行:${bad}`);
  }
}

// ---- 主流程 -------------------------------------------------------------------------

/** 一个工程的一整轮:字典 → TS → 壳 → 键双向 → CSS。返回统计供收尾打印。 */
function scanProject(proj, errs, regHits, dynFound) {
  // 字典:全收 + 重键 + 占位符奇偶 + en 侧 CJK。两种来路(locales/ 分片 / 壳内联)只是
  // 取块方式不同,形状与后面每一条判据完全共用。
  const dict = new Map();
  const shellOpts = new Map(); // shell rel -> {bindings?, mask?}
  let parts;
  if (proj.dict.kind === "shards") {
    const partFiles = walkDir(proj.dict.dir, [".ts"]).filter((f) => !f.endsWith("/entry.ts") && !f.endsWith("/index.ts"));
    for (const rel of partFiles) {
      for (const [key, entry] of parsePart(rel, errs)) {
        if (dict.has(key)) errs.push(`[${proj.label}] 跨分片重键:${key}(${rel})`);
        dict.set(key, { ...entry, file: rel });
      }
    }
    const indexSrc = readFileSync(resolve(root, `${proj.dict.dir}/index.ts`), "utf8");
    for (const rel of partFiles) {
      const base = rel.split("/").pop().replace(/\.ts$/, "");
      if (!indexSrc.includes(`from "./${base}"`)) errs.push(`${rel} 没有 import 进 ${proj.dict.dir}/index.ts`);
      if (!indexSrc.includes(`...${base},`)) errs.push(`${rel} 没有 spread 进 messages(import 了也白搭)`);
    }
    parts = `${partFiles.length} 分片`;
  } else {
    const rel = proj.dict.file;
    const { entries, mask } = parseInlineDict(rel, errs);
    for (const [key, entry] of entries) dict.set(key, { ...entry, file: rel });
    shellOpts.set(rel, { bindings: parseBindings(rel), mask });
    parts = "壳内联一份";
  }
  // 复数选择器 `{n|单数|复数}`(363):它也是 n 的一处用法,故占位符集合要把它算进来 ——
  // 否则「en 只在选词里用了 n、忘了写 {n}」这类漂移在集合比对里是**看不见的**。
  // ⚠ 带 g 的正则 .test() 会推进 lastIndex,别拿同一只既 replace 又 test(状态性判据 =
  // 隔一个调用就换答案)。故这里两只:一只专供 replace(g),一只专供判断(无 g)。
  const PLURAL_G = /\{([A-Za-z0-9_]+)\|[^|{}]*\|[^|{}]*\}/g;
  const HAS_PLURAL = /\{[A-Za-z0-9_]+\|[^|{}]*\|[^|{}]*\}/;
  const stripPlural = (s) => s.replace(PLURAL_G, "");
  // 判据比的是「**打印出来**的那一组占位符」:先把复数选择器整只摘掉,再照 358 的原样比。
  // ⚠ 别改成「把选择器归一成 {n} 再去重」—— 那样「en 只在选词里用了 n、忘了打印数字」
  // 与正常写法就无从分辨了(刀 ㉖ 当场逮住过这个写法)。选词不等于打印。
  const ph = (s) => [...stripPlural(s).matchAll(/\{[A-Za-z0-9_]+\}/g)].map((m) => m[0]).sort().join(",");
  for (const [key, e] of dict) {
    if (ph(e.zh) !== ph(e.en)) errs.push(`${e.file}「${key}」zh/en 占位符集合不等:[${ph(e.zh)}] / [${ph(e.en)}]`);
    // 中文没有复数:zh 侧写了选择器一律是误用(且会原样漏到界面上)。
    if (HAS_PLURAL.test(e.zh)) errs.push(`${e.file}「${key}」zh 值里出现复数选择器(中文没有复数形):${e.zh}`);
    // 形不对的选择器(少一支 / 多一支 / 名字带别的字符)不会被 t() 认出来,会**原样印到界面上**;
    // 判据 = 把合法的先摘掉,再看还有没有「花括号里带竖线」的残渣。
    for (const side of ["zh", "en"]) {
      const bad = stripPlural(e[side]).match(/\{[^{}]*\|[^{}]*\}/);
      if (bad) errs.push(`${e.file}「${key}」${side} 值里有形不对的复数选择器(要 {名|单数|复数}):${bad[0]}`);
    }
    // ⚠ 选择器引用了调用方没传的名字时,t() **只在英文档下** throw —— 而 e2e / CDP 资产
    // 全跑中文(i18n-plan §1 的刻意选择),这一类错它们一个都看不见。故要求选择器的名字
    // 必须同时出现在**打印出来**的那组里:那样中文路径的既有覆盖就连它一起兜住了。
    const printed = new Set([...stripPlural(e.en).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]));
    for (const m of e.en.matchAll(PLURAL_G)) {
      if (!printed.has(m[1])) {
        errs.push(
          `${e.file}「${key}」复数选择器 {${m[1]}|…} 的名字没出现在打印占位符里 ——` +
            `这样它只在英文档下才会炸,而中文路径的覆盖兜不住它`
        );
      }
    }
    if (CJK.test(e.en) && !EN_CJK_REGISTRY.some((r) => r.file === e.file && r.key === key)) {
      errs.push(`${e.file}「${key}」en 值含 CJK 且未登记:${e.en}`);
    }
  }

  // TS:CJK 违例 + t 调用点收集(官网没有 TS 面,proj.ts = null)
  const tsFiles = proj.ts
    ? walkDir(proj.ts, [".ts"]).filter((f) => !(proj.dict.kind === "shards" && f.startsWith(`${proj.dict.dir}/`)) && !f.endsWith(".d.ts"))
    : [];
  const usedKeys = new Map();
  const use = (key, where) => {
    if (!usedKeys.has(key)) usedKeys.set(key, []);
    usedKeys.get(key).push(where);
  };
  let diagCount = 0;
  for (const rel of tsFiles) {
    const src = readFileSync(resolve(root, rel), "utf8");
    const { strings, blanked } = lexTs(src, rel);
    for (const s of strings) {
      if (!CJK.test(s.raw)) continue;
      if (isDiagnostic(src, s.start)) {
        diagCount++;
        continue;
      }
      const reg = STRING_REGISTRY.findIndex((r) => r.file === rel && r.value === s.raw);
      if (reg !== -1) {
        regHits.add(reg);
        continue;
      }
      errs.push(`${rel}:${s.line} 写死的可见中文(走字典或进 STRING_REGISTRY):${s.raw.slice(0, 40)}`);
    }
    for (const m of blanked.matchAll(/\bt\(\s*"/g)) {
      const qAt = m.index + m[0].length - 1; // 开引号位;lexTs 记 start = 引号自身
      const hit = strings.find((s) => s.start === qAt);
      if (!hit) throw new Error(`${rel}:t( 后面的字面量没对上词法结果 —— 词法看不懂`);
      use(unq(hit.raw, rel), `${rel}:${hit.line}`);
    }
    const dyn = [...blanked.matchAll(/(?<!function )\bt\(\s*[^"\s)]/g)].length; // 声明 function t( 自身不算调用点
    if (dyn > 0) dynFound.set(rel, dyn);
  }

  // 壳
  for (const rel of proj.shells) scanShell(rel, dict, usedKeys, errs, shellOpts.get(rel));

  // 键双向(逐工程:两边键空间独立)
  for (const [key, wheres] of usedKeys) {
    if (!dict.has(key)) errs.push(`[${proj.label}] 用了字典里没有的键「${key}」(${wheres[0]} 等 ${wheres.length} 处;运行期会 throw)`);
  }
  for (const [key, e] of dict) {
    if (!usedKeys.has(key)) errs.push(`${e.file}:${e.line} 键「${key}」存而不用`);
  }

  // *.css:注释外不许有 CJK(安卓的样式内联在壳里,由判据②盖住,故 css 面为 null)
  for (const rel of proj.css ? walkDir(proj.css, [".css"]) : []) {
    const src = readFileSync(resolve(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
    src.split("\n").forEach((line, idx) => {
      if (CJK.test(line)) errs.push(`${rel}:${idx + 1} CSS 注释外出现 CJK:${line.trim().slice(0, 50)}`);
    });
  }

  return { dict, parts, tsCount: tsFiles.length, diagCount };
}

function main() {
  selfCheck();
  const errs = [];
  const regHits = new Set();
  const dynFound = new Map();

  const stats = PROJECTS.map((p) => ({ proj: p, ...scanProject(p, errs, regHits, dynFound) }));

  // 登记表的反向核(跨工程一次算总账)
  STRING_REGISTRY.forEach((r, i) => {
    if (!regHits.has(i)) errs.push(`STRING_REGISTRY 没命中:${r.file} 「${r.value}」(改掉了就删这行)`);
  });
  for (const [file, count] of dynFound) {
    const reg = DYNAMIC_T.find((r) => r.file === file);
    if (!reg) errs.push(`${file} 有 ${count} 处动态 t() 调用未登记(键静态核不了,进 DYNAMIC_T 说明键集由谁覆盖)`);
    else if (reg.count !== count) errs.push(`${file} 动态 t() 计数漂移:登记 ${reg.count} / 实际 ${count}`);
  }
  for (const r of DYNAMIC_T) {
    if (!dynFound.has(r.file)) errs.push(`DYNAMIC_T 没命中:${r.file}(没有动态调用了就删这行)`);
  }
  for (const r of EN_CJK_REGISTRY) {
    // 按「哪份字典里有这个键、且它就住在登记的那个文件」找,不靠工程的目录形状反推
    const e = stats.map((s) => s.dict.get(r.key)).find((x) => x && x.file === r.file);
    if (!e || !CJK.test(e.en)) errs.push(`EN_CJK_REGISTRY 的 ${r.file}「${r.key}」没命中(键没了、换了分片或 en 已无 CJK)`);
  }
  // SHELL_REGISTRY 的处数在 scanShell 里逐条对过;这里只核「登记的文件真被扫过」
  for (const r of SHELL_REGISTRY) {
    if (!PROJECTS.some((p) => p.shells.includes(r.file))) errs.push(`SHELL_REGISTRY 的 ${r.file} 不在任何工程的壳清单里 —— 这条登记没人核`);
  }

  // ⑨ 两端必须说同一句话的键(共有集只在 CROSS_END_PROJECTS 那几个工程之间核)
  for (const label of CROSS_END_PROJECTS) {
    if (!PROJECTS.some((p) => p.label === label)) errs.push(`CROSS_END_PROJECTS 里的「${label}」不是任何一个工程 —— 这半边的登记没人核`);
  }
  for (const r of CROSS_END_KEYS) {
    const got = stats.filter((s) => CROSS_END_PROJECTS.includes(s.proj.label)).map((s) => ({ label: s.proj.label, e: s.dict.get(r.key) }));
    const missing = got.filter((g) => !g.e);
    if (missing.length) {
      errs.push(`CROSS_END_KEYS 的「${r.key}」在 ${missing.map((m) => m.label).join(" / ")} 侧不存在(两端须同名同值;不再共有就删这行登记)`);
      continue;
    }
    for (const field of ["zh", "en"]) {
      const vals = [...new Set(got.map((g) => g.e[field]))];
      if (vals.length > 1) {
        errs.push(`CROSS_END_KEYS 的「${r.key}」两端 ${field} 值不同:${got.map((g) => `${g.label}「${g.e[field]}」`).join(" / ")}`);
      }
    }
  }

  if (errs.length) {
    console.error(`i18n 文案门禁不过(${errs.length} 条):`);
    for (const e of errs) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  const diagTotal = stats.reduce((a, s) => a + s.diagCount, 0);
  for (const s of stats) {
    console.log(
      `i18n 门禁通过[${s.proj.label}]:字典 ${s.dict.size} 键(${s.parts})/ 扫 ${s.tsCount} 份 TS + ${s.proj.shells.length} 壳,键双向、占位符奇偶、壳原文=zh 字典逐字全核。`,
    );
  }
  console.log(
    `  诊断豁免 ${diagTotal} 串(throw/console,与「Rust 侧不翻」同线);跨端同名同值键 ${CROSS_END_KEYS.length} 枚;壳内签字 ${SHELL_REGISTRY.length} 处(字体名 / 印文,带处数);挂账 0(360 起三个工程判据相同,账本已退役)。`,
  );
  console.log(
    "  ⚠ 诚实边界:Rust 侧(core/两壳)不在扫描面 —— 后端错误经 String(e) 透传仍是中文;拼接出来的动态文案与变量传 t() 的键静态核不了(后者按 DYNAMIC_T 恰等计数);三份字典的**其余**键值不互相对账(只 CROSS_END_KEYS 那几枚);e2e/CDP 资产刻意钉 zh 不扫;官网 markup 是中文那一份 —— 爬虫与首帧拿到的都是它(已接受)。",
  );
}

main();
