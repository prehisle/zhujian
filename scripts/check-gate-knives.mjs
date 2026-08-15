#!/usr/bin/env node
// 三道门禁的**阴性对照**跑手(341/342/343 三只合一,343 收进仓)。
//
// 一刀 = 往仓里注入一个**该被逮到**的改动 → 跑门禁 → 必须真红 → 原样还回去。
//
// # 为什么它该在仓里
//
// 门禁是永久的,而门禁**失灵的方式是安静的绿**:抓取器少认一种写法、层叠被改窄、某条
// 规则被顺手放平 —— 表现全是「通过」。「这道闸今天还有没有牙齿」只有阴性对照答得出来,
// 所以它是门禁自己的**回归网**,与 `check-contrast-xcheck.mjs` 同一个角色(也与仓里早有的
// `mutation-check.mjs` 同族:那只管测试有没有牙齿,这只管门禁有没有牙齿)。
// 341/342/343 各写过一只放在仓外,结果是三只孤儿 —— 谁都不会跑第二次。
//
// # 三条纪律(都是踩出来的,别删)
//
// ① **跑手自己要有阳性对照**(339):开跑前先证基线绿,每刀跑完还原并复证基线又绿。
//    339 第一版把门禁路径拼成 `scripts/scripts/…`,九条「红」全是 MODULE_NOT_FOUND 的
//    假红 —— **一只跑不起来的跑手和一只把什么都判红的跑手,输出是一样的**。
// ② **红的理由也要对**(342):每刀带 `expect`,红里必须真出现那句话。只核「有没有 ✗ 行」
//    的话,一刀因为**别的原因**红了同样算过 —— 而好几刀注入的改动本来就会顺带触发别的
//    检查(比如「阶下加一档并真拿它用」)。
// ③ **一刀红了不等于它证到了它该证的那件事**(342 的对拍工装那边栽过):挑锚点要挑
//    「除了这条规则没人会管它」的地方,否则红被别的断言吸收掉。
//
// # 用法
//
//   node scripts/check-gate-knives.mjs [radius|fs|contrast|hit|i18n|all] [--with-chrome]
//
// 默认 all。`--with-chrome` 才跑打在 `check-contrast-xcheck.mjs` 上的那两刀(要真 Chrome,
// 一刀约一分钟;Linux 上 `/usr/bin/google-chrome` 那只 wrapper 有 bug,用
// `CHROME=/opt/google/chrome/google-chrome`)。
//
// **它不是发版门禁**(发版跑的是七道 check-*),是那三道闸的回归网 —— 改动门禁本身、
// 或改动它守着的那套令牌/登记表之后跑它。⚠ 它会**临时改工作区文件**再还原,所以别在
// 有未保存改动的编辑器里跑,也别与别的写文件的活并行。

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const F = (p) => resolve(ROOT, p);
const NL = String.fromCharCode(10);

const withChrome = process.argv.includes("--with-chrome");
const want = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "all";

/** 跑一只脚本。stdout 与 stderr 都收 —— 门禁抛出来的话消息在 stderr。
 *  `env` 给「刀不是改文件、而是换掉门禁的输入」的那种(366 的 deployed 组:线上是好的
 *  时候,那几条分支在真跑里一条都到不了)。 */
function run(script, env) {
  try {
    const out = execFileSync("node", [F(script)], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { code: 0, out };
  } catch (e) {
    if (e.stdout === undefined) return { code: -1, out: String(e.message) }; // 工装自己崩了
    return { code: e.status ?? 1, out: e.stdout + (e.stderr ?? "") };
  }
}

// ---- 刀 ------------------------------------------------------------------------------
// 一刀 = { n 名字, expect 期望在红里出现的话(串或串数组), edits [[文件, 找, 换]],
//          tool 打在哪只工装上(默认本组的门禁), note 值得记一句的 }

const SUITES = {
  // ===== 341:圆角阶 =====================================================================
  radius: {
    gate: "scripts/check-radius-drift.mjs",
    title: "check-radius-drift(341,圆角阶)",
    knives: [
      { n: "① 令牌表改一个值(桌面 --radius-md 12 → 11)", expect: "漂移",
        edits: [["src/theme.css", "--radius-md: 12px;", "--radius-md: 11px;"]] },
      { n: "② 规范 §2.5 表里改一个值(sm 8px → 9px)", expect: "漂移",
        edits: [["docs/ui-guidelines.md", "| `--radius-sm` | 8px |", "| `--radius-sm` | 9px |"]] },
      { n: "③ 一处用法改回字面量", expect: "没走令牌,也没在登记表里",
        edits: [["src/board.css", "border-radius: var(--radius-md);", "border-radius: 10px;"]] },
      { n: "④ 登记表某条不再命中(.wc 的 0 改成走令牌)", expect: "一处都没命中",
        edits: [["notebook.html", "border-radius: 0;", "border-radius: var(--radius-xs);"]] },
      { n: "⑤ 令牌表多一个规范表里没有的令牌", expect: "而规范 §2.5 表里没有这一行",
        edits: [["site/index.html", "--radius-seal: 25%;", "--radius-seal: 25%;\n        --radius-2xl: 24px;"]] },
      { n: "⑥ 阶里多一档但一处都没人用(三份 + 规范同时加)", expect: "一处都没人用",
        edits: [
          ["src/theme.css", "--radius-seal: 25%;", "--radius-seal: 25%;\n  --radius-2xl: 24px;"],
          ["android/index.html", "--radius-seal: 25%;", "--radius-seal: 25%;\n        --radius-2xl: 24px;"],
          ["site/index.html", "--radius-seal: 25%;", "--radius-seal: 25%;\n        --radius-2xl: 24px;"],
          ["docs/ui-guidelines.md", "| `--radius-circle` | 50% |",
           "| `--radius-2xl` | 24px | 没人用的一档 |\n| `--radius-circle` | 50% |"],
        ] },
      { n: "⑦ 行内 style 写圆角(扫描面之外)", expect: "有行内 style 写圆角",
        edits: [["index.html", "<body>", '<body><div style="border-radius:3px"></div>']] },
      { n: "⑧ 长写法改回字面量(证明它真进了扫描面)", expect: "没走令牌,也没在登记表里",
        note: "341 前半程 190 处的人工盘点整个漏了这种写法,是第一版那道探针逮到的",
        edits: [["src/item-images.css", "border-top-right-radius: var(--radius-xs);",
                 "border-top-right-radius: 5px;"]] },
    ],
  },

  // ===== 342:字号阶 =====================================================================
  fs: {
    gate: "scripts/check-fs-drift.mjs",
    title: "check-fs-drift(342,字号阶)",
    knives: [
      { n: "① 令牌表改一个值(桌面 --fs-13 13 → 14)", expect: "漂移",
        edits: [["src/theme.css", "--fs-13: 13px;", "--fs-13: 14px;"]] },
      { n: "② 规范 §2.2 表里改一个值(--fs-14 14px → 15px)", expect: "漂移",
        edits: [["docs/ui-guidelines.md", "| `--fs-14` | 14px |", "| `--fs-14` | 15px |"]] },
      { n: "③ 一处用法改回字面量(toast)", expect: "没走令牌,也没在登记表里",
        edits: [["src/toast.css", "font-size: var(--fs-12);", "font-size: 12px;"]] },
      { n: "④ 登记表某条不再命中(.tf-caret 的 9px 改成走令牌)", expect: "一处都没命中",
        edits: [["src/filter-bar.css", "font-size: 9px;", "font-size: var(--fs-12);"]] },
      { n: "⑤ 令牌表多一个规范表里没有的令牌", expect: "而规范 §2.2 表里没有这一行",
        edits: [["site/index.html", "--fs-30: 30px;", "--fs-30: 30px;\n        --fs-40: 40px;"]] },
      { n: "⑥ 阶里多一档但一处都没人用(三份 + 规范同时加)", expect: "一处都没人用",
        edits: [
          ["src/theme.css", "--fs-30: 30px;", "--fs-30: 30px;\n  --fs-40: 40px;"],
          ["android/index.html", "--fs-30: 30px;", "--fs-30: 30px;\n        --fs-40: 40px;"],
          ["site/index.html", "--fs-30: 30px;", "--fs-30: 30px;\n        --fs-40: 40px;"],
          ["docs/ui-guidelines.md", "| `--fs-30` | 30px |",
           "| `--fs-30` | 30px | 大字形按钮 |\n| `--fs-40` | 40px |"],
        ] },
      { n: "⑦ 行内 style 写字号(扫描面之外)", expect: "有行内 style 写字号",
        edits: [["index.html", "<body>", '<body><div style="font-size:9px"></div>']] },
      { n: "⑧ font 简写里的字号改回字面量(证明简写解析没退化)", expect: "没走令牌,也没在登记表里",
        note: "342 的改写器假设「px 打头」,而对账抄了同一个假设,于是报了「零漏网」",
        edits: [["android/index.html", "font: 600 var(--fs-15)/1.4", "font: 600 15px/1.4"]] },
      { n: "⑨ 阶下加一档 --fs-9 并真拿它用(§2.2 第一条被从令牌那头挖掉)",
        expect: "阶里出现了小于 12px 的档",
        edits: [
          ["src/theme.css", "--fs-12: 12px;", "--fs-9: 9px;\n  --fs-12: 12px;"],
          ["android/index.html", "--fs-12: 12px;", "--fs-9: 9px;\n        --fs-12: 12px;"],
          ["site/index.html", "--fs-12: 12px;", "--fs-9: 9px;\n        --fs-12: 12px;"],
          ["docs/ui-guidelines.md", "| `--fs-12` | 12px |",
           "| `--fs-9` | 9px | 偷偷开的后门 |\n| `--fs-12` | 12px |"],
          ["src/filter-bar.css", "font-size: 9px;", "font-size: var(--fs-9);"],
        ] },
      { n: "⑩ 登记表里塞一条 ≥12px 的(拿登记绕过收敛)",
        expect: "那一档阶里就有,该走令牌而不是登记",
        edits: [
          ["scripts/check-fs-drift.mjs", 'selector: ".tf-caret", value: "9px"',
           'selector: ".tf-caret", value: "13px"'],
          ["src/filter-bar.css", "font-size: 9px;", "font-size: 13px;"],
        ] },
    ],
  },

  // ===== 356:热区门禁 ===================================================================
  hit: {
    gate: "scripts/check-hit-zone.mjs",
    title: "check-hit-zone(356,热区)",
    knives: [
      { n: "① 剥掉一枚扩展(.cm-close 从 ::before 组摘除)", expect: ".cm-close 给不出",
        edits: [["src/controls.css", ".cm-close::before,\n.v-board .col-copy::before,",
                 ".v-board .col-copy::before,"]] },
      { n: "② 扩展宿主失位(.cm-close 从 relative 组摘除)", expect: "不是定位元素",
        edits: [["src/controls.css", ".cm-close,\n.v-board .col-copy,",
                 ".v-board .col-copy,"]] },
      { n: "③ 扩展缩水(24 → 20:达不到底线的扩展不算自保)", expect: ".v-inbox .tag-x 给不出",
        edits: [["src/controls.css", "  width: 24px;\n  height: 24px;",
                 "  width: 20px;\n  height: 20px;"]] },
      { n: "④ 新的小按钮出生即被拦(枚举面自动收新控件)", expect: ".v-board .tiny-new 给不出",
        edits: [["src/board.css", ".v-board .col-copy {",
                 ".v-board .tiny-new { cursor: pointer; width: 16px; height: 16px; }\n.v-board .col-copy {"]] },
      { n: "⑤ 登记表某条不再命中(过期的例外什么都不守)", expect: "没命中任何签名",
        edits: [["scripts/check-hit-zone.mjs", 'selector: ".tf-caret"', 'selector: ".tf-caretX"']] },
      { n: "⑥ 已有自保仍留登记(反方向:别让旧登记盖住回退)", expect: "如今已有自保",
        note: "给 .seg-btn 抬 1px 上下衬垫(行盒 23→25)—— 它那条 accepted 登记就该当场变过期",
        edits: [["src/settings.css", "  padding: 5px 14px;", "  padding: 6px 14px;"]] },
      { n: "⑦ 底线放平(FLOOR 24 → 20:把红修掉的最省事写法)", expect: "低于 §2.3 的 24",
        note: "FLOOR 变小会让一批 pending 登记「已有自保」——那些红是这一刀的副产物,expect 钉的是自看断言",
        edits: [["scripts/check-hit-zone.mjs", "const FLOOR = 24;", "const FLOOR = 20;"]] },
      { n: "⑧ 行高 <1 且未登记(行盒下界的前提被挖角)", expect: "< 1 且未登记",
        edits: [["src/search.css", ".v-search .clear {",
                 ".v-search .probe-lh { line-height: 0.5; }\n.v-search .clear {"]] },
      { n: "⑨ font 简写冒出认不出的字号(pt):抓取器必须抛,不许安静少判", expect: "认不出字号",
        edits: [["src/board.css", ".v-board .col-copy {",
                 ".v-board .probe-font { font: 13pt serif; }\n.v-board .col-copy {"]] },
      { n: "⑩ 扩展识别层整层失灵(正向探针必须自己响)", expect: "扩展识别层失灵",
        edits: [["scripts/check-hit-zone.mjs", 'if (ex.d.position !== "absolute") continue;',
                 'if (ex.d.position !== "absoluteX") continue;']] },
      { n: "⑪ 扩展宿主变自剪裁(overflow:hidden 会把 ::before 裁成死扩展)", expect: "死扩展",
        edits: [["src/item-comments.css", ".cm-more {", ".cm-more {\n  overflow: hidden;"]] },
    ],
  },

  // ===== 343:对比度门禁的字号那一层 =====================================================
  contrast: {
    gate: "scripts/check-contrast.mjs",
    xcheck: "scripts/check-contrast-xcheck.mjs",
    title: "check-contrast 的字号那一层(343,§2.2 第二条「小 × 淡」)",
    knives: [
      { n: "① 安卓通知条退回 13px(颜色一个字不动)",
        expect: [".error.notice", "字号 13px", "4.79"],
        note: "与基线成一红一绿对照:同一对颜色,14px 绿、13px 红 —— 判的是**组合**不是颜色本身",
        edits: [["android/index.html", "font-size: var(--fs-14); word-break: break-all;",
                 "font-size: var(--fs-13); word-break: break-all;"]] },
      { n: "② 标签详情复制钮的 hover 退回朱砂",
        expect: [".v-topics .dtask-copy:hover", "字号 12px", "4.87"],
        note: "它的字号来自 `font: var(--fs-12)/1 …` **简写**,这一刀同时守着简写那条取数路",
        edits: [["src/topics.css", ".dtask-copy:hover { border-color: var(--seal); color: var(--ink); }",
                 ".dtask-copy:hover { border-color: var(--seal); color: var(--seal); }"]] },
      { n: "③ 字号抓取器整个失灵(恒返回「没有」)",
        expect: "一个签名的字号都没算出来",
        note: "这一层塌掉的表现是**全绿**(每组退回 4.5),所以必须有一条断言自己响",
        edits: [["scripts/check-contrast.mjs", "function fontSizeIn(body, where) {\n  let out = null;",
                 "function fontSizeIn(body, where) {\n  let out = null;\n  if (body) return null;"]] },
      { n: "④ 小字那一档被抹平(SMALL_PX = 0)",
        expect: "没有任何一个签名落在小字那一档",
        edits: [["scripts/check-contrast.mjs", "const SMALL_PX = 14;", "const SMALL_PX = 0;"]] },
      { n: "⑤ 底线被悄悄放平(SMALL_FLOOR = FLOOR)",
        expect: "没有严格高过 FLOOR",
        note: "把红「修」掉的最省事写法,而它一条别的断言都不会红",
        edits: [["scripts/check-contrast.mjs", "const SMALL_FLOOR = 5;", "const SMALL_FLOOR = 4.5;"]] },
      { n: "⑥ 认不出字号的 font 简写(必须当场抛,不许静静跳过)",
        expect: "认不出字号",
        edits: [["src/topics.css", ".v-topics .dtask-copy {",
                 ".v-topics .dtask-zzprobe { font: 600 clamp(9px, 1vw, 11px) serif; }\n.v-topics .dtask-copy {"]] },
      { n: "⑦ @media 块里出现字号",
        expect: "块里有带颜色或字号的规则",
        note: "扁平抓取器会把条件块里的声明当成无条件生效的 —— 两个方向都可能算错",
        edits: [["src/board.css", "  .v-board header .copy-slot { display: none; }",
                 "  .v-board header .copy-slot { display: none; font-size: var(--fs-12); }"]] },
      { n: "⑧ 字号写在**另一条只写字号的规则**里(跨规则取数)",
        expect: [".v-topics .zzprobe", "字号 13px"],
        note: "只写 font-size 的规则若没进层叠,这个签名就是「字号不知道」→ 退回 4.5 → 4.79 平安过关",
        edits: [["src/topics.css", ".v-topics .dtask-copy {",
                 ".v-topics .zzprobe { color: var(--on-seal); background: var(--ok); }\n" +
                 ".v-topics .zzprobe { font-size: var(--fs-13); }\n.v-topics .dtask-copy {"]] },
      { n: "⑨ 门禁报一个错的字号(对拍工装那一格有没有牙齿)",
        expect: "FSDIFF", tool: "xcheck",
        edits: [["scripts/check-contrast.mjs", '${j.px === null ? "?" : j.px}px',
                 '${j.px === null ? "?" : j.px + 1}px']] },
      { n: "⑩ 门禁把字号全说成「不知道」(对拍工装的正控 ④)",
        expect: "门禁一组字号都没算出来", tool: "xcheck",
        note: "这一刀门禁自己是**绿**的(全退回 4.5),只有对拍那道正控会响",
        edits: [["scripts/check-contrast.mjs", "        px, floor, allowed: !!allow,",
                 "        px: null, floor, allowed: !!allow,"]] },
    ],
  },

  // ===== 358:i18n 文案出处 ==============================================================
  i18n: {
    gate: "scripts/check-i18n-drift.mjs",
    xcheck: "scripts/check-site-i18n-render.mjs", // 360:官网那份的运行期对拍(要真 Chrome)
    title: "check-i18n-drift(358,文案出处)",
    knives: [
      { n: "① TS 里新写死可见中文", expect: "写死的可见中文",
        edits: [["src/toast.ts", "export function", 'const KNIFE = "刀一中文";' + NL + "export function"]] },
      { n: "② 壳原文与 zh 字典漂移", expect: "原文与 zh 字典漂移",
        edits: [["notebook.html", 'data-i18n="shell.navIdeas">灵感<', 'data-i18n="shell.navIdeas">灵感X<']] },
      { n: "③ 壳中文摘掉 data-i18n(未绑)", expect: "未绑 data-i18n 的中文",
        edits: [["notebook.html", ' data-i18n="shell.navSearch">搜索', ">搜索"]] },
      { n: "④ 字典键存而不用", expect: "存而不用",
        edits: [["src/locales/common.ts", "});", '  "common.knife": { zh: "刀", en: "knife" },' + NL + "});"]] },
      { n: "⑤ zh/en 占位符集合不等", expect: "占位符集合不等",
        edits: [["src/locales/settings.ts", 'en: "This device · {id}"', 'en: "This device"']] },
      { n: "⑥ en 值混进 CJK 未登记", expect: "en 值含 CJK 且未登记",
        edits: [["src/locales/common.ts", 'zh: "保存", en: "Save"', 'zh: "保存", en: "保存"']] },
      { n: "⑦ 分片不合形(模板串)", expect: "不合分片形",
        edits: [["src/locales/common.ts", "});", '  "common.bad": { zh: `模板`, en: "y" },' + NL + "});"]] },
      { n: "⑧ 官网壳里新写死中文(360 起账本退役、由壳扫描面接手)", expect: "未绑 data-i18n 的中文",
        edits: [["site/index.html", '<title data-i18n="meta.title">', "<p>刀八新写死</p>" + NL + '    <title data-i18n="meta.title">']] },
      { n: "⑨ 动态 t() 调用未登记", expect: "动态 t() 调用未登记",
        edits: [["src/toast.ts", "export function", "function kfKnife(k: never): string { return t(k); }" + NL + "export function"]] },
      { n: "⑩ 用了字典里没有的键", expect: "用了字典里没有的键",
        edits: [["src/toast.ts", "export function", 'const K2 = t("no.suchKey");' + NL + "export function"]] },
      { n: "⑪ STRING_REGISTRY 登记不再命中", expect: "STRING_REGISTRY 没命中",
        edits: [["src/update.ts", '"安卓版"', '"安卓版本"']],
        note: "顺带也触发「写死的可见中文」(改出的新值未登记)—— 锚的是「没命中」那半边的牙齿" },
      { n: "⑫ data-i18n 元素塞进子元素", expect: "带子元素",
        edits: [["notebook.html", '<span data-i18n="shell.sync">同步</span>', '<span data-i18n="shell.sync">同<b>步</b></span>']] },
      // 359(第②笔)起安卓也进正扫描面:上面①-⑦、⑨-⑫ 全打在桌面那一份上,下面四刀
      // 证「同一套判据在安卓工程上也真在跑」——两个工程各扫一遍,漏扫一整个工程是安静的绿。
      { n: "⑬ 安卓 TS 里新写死可见中文", expect: "写死的可见中文",
        edits: [["android/src/swipe.ts", "import ", 'const KNIFE_I18N = "新写死";' + NL + "import "]] },
      { n: "⑭ 安卓壳原文与 zh 字典漂移", expect: "原文与 zh 字典漂移",
        edits: [["android/index.html", 'data-i18n="shell.navIdeas">灵感<', 'data-i18n="shell.navIdeas">灵感X<']] },
      { n: "⑮ 安卓壳中文摘掉 data-i18n(未绑)", expect: "未绑 data-i18n 的中文",
        edits: [["android/index.html", ' data-i18n="shell.navTasks">任务', ">任务"]] },
      { n: "⑯ 两端同名键值漂移(CROSS_END_KEYS)", expect: "两端 zh 值不同",
        edits: [["android/src/locales/filter.ts", '"filter.all": { zh: "所有"', '"filter.all": { zh: "全部"']] },
      { n: "⑰ 两端同名键在一端消失(CROSS_END_KEYS)", expect: "侧不存在",
        edits: [["android/src/locales/filter.ts", '"filter.thatTag"', '"filter.thatTagX"']],
        note: "顺带也触发「用了字典里没有的键」与「存而不用」—— 锚的是共有集那半边的牙齿" },
      // 360(第③笔)起官网也进正扫描面(⑧ 已改打在它身上)。下面六刀证「同一套判据在
      // 官网这一份上也真在跑」,外加它独有的三处形状闸:取块标记 / BIND 表 / 壳内签字。
      { n: "⑱ 官网壳中文摘掉 data-i18n(未绑)", expect: "未绑 data-i18n 的中文",
        edits: [["site/index.html", ' data-i18n="nav.flow">怎么用', ">怎么用"]],
        note: "nav.flow 页脚还用着,故只该报「未绑」、不该报「存而不用」" },
      { n: "⑲ 官网壳原文与内联字典漂移", expect: "原文与 zh 字典漂移",
        edits: [["site/index.html", 'data-i18n="nav.download">下载<', 'data-i18n="nav.download">下载X<']] },
      { n: "⑳ 官网内联字典键存而不用", expect: "存而不用",
        edits: [["site/index.html", '"foot.copy":', '"foot.knife": { zh: "刀", en: "knife" },' + NL + '          "foot.copy":']] },
      { n: "㉑ 内联字典的取块标记被挪走", expect: "内联字典标记不是恰一对",
        edits: [["site/index.html", "var M = { /* ⟦i18n-dict⟧ */", "var M = {"]],
        note: "取块认不出边界必须当场抛 —— 猜出来的边界会让整段字典静默不受核" },
      { n: "㉒ BIND 绑定表被改成读不懂的形状", expect: "BIND 表里有看不懂的项",
        edits: [["site/index.html", '{ "data-i18n-title": "title"', "{ title: \"title\""]],
        note: "官网支持哪几个 data-i18n-* 是从这张表读的;读不动就抛,不退回默认三条" },
      { n: "㉓ 壳内签字处数漂移(印文多一处)", expect: "SHELL_REGISTRY 处数漂移",
        edits: [["site/index.html", ">朱</text>", ">简</text>"]] },
      // 官网那份的**运行期**(--with-chrome 才跑):静态门禁核不了「那段脚本跑起来会
      // 把字换成什么」,这两刀打在补这一格的对拍工装上。
      { n: "㉔ 运行期根本没把字换掉", expect: "屏幕上「", tool: "xcheck",
        edits: [["site/index.html", 'texts[i].textContent = t(texts[i].getAttribute("data-i18n"));', "texts[i].textContent = texts[i].textContent;"]],
        note: "zh 那一轮照样全对(markup 本来就是中文)—— 只有 en 那一轮会红,这正是它该守的那一格" },
      { n: "㉕ 语言判定坏掉(恒中文)", expect: "语言可能压根没切", tool: "xcheck",
        edits: [["site/index.html", 'return navigator.language.toLowerCase().indexOf("zh") === 0 ? "zh" : "en";', 'return "zh";']] },
      // 363:复数选择器 {n|单数|复数}。三刀分别打三条新判据 —— 少任何一条,写错的写法
      // 都会**原样印到界面上**(而界面上多一对花括号,看着像数据问题不像文案问题)。
      { n: "㉖ en 只在选词里用了变量、忘了打印数字", expect: "占位符集合不等",
        edits: [["src/locales/topics.ts", '"{ideas} {ideas|idea|ideas} · {tasks}', '"{ideas|idea|ideas} · {tasks}']],
        note: "去重后集合仍要相等 —— 这刀证明去重没把「en 少一个变量」一起去掉" },
      { n: "㉗ zh 侧写了复数选择器(中文没有复数形)", expect: "zh 值里出现复数选择器",
        edits: [["src/locales/topics.ts", 'zh: "{n} 个子标签"', 'zh: "{n} 个{n|子标签|子标签}"']] },
      { n: "㉘ 选择器形不对(少一支),t() 认不出会原样印出去", expect: "形不对的复数选择器",
        edits: [["src/locales/comments.ts", '"{n} {n|match|matches}"', '"{n} {n|matches}"']] },
      // ㉙㉚ 打在**运行期**那只上(不要 Chrome):静态门禁核不了「t() 跑起来选了哪一支」,
      // 而 e2e / 安卓 CDP 全跑中文,复数那几行在既有回归里是死角。
      { n: "㉙ 两支写反了(单复数对调)", expect: "不是「单数 + s/es」", tool: "scripts/check-i18n-plural-render.mjs",
        edits: [["src/locales/topics.ts", "{n|tag|tags} into “", "{n|tags|tag} into “"]],
        note: "①②③ 的期望全从同一份字典推出,字典写反了就自证成立 —— 只有判据④(不来自字典的英语知识)抓得住" },
      { n: "㉚ t() 的选词整只失效(选择器原样印出去)", expect: "没被认出的写法", tool: "scripts/check-i18n-plural-render.mjs",
        edits: [["src/i18n.ts", "const PLURAL = /\\{([A-Za-z0-9_]+)\\|", "const PLURAL = /\\{([A-Za-z0-9_]+)\\#"]] },
    ],
  },

  // ===== 366:线上对账 ===================================================================
  // ⚠ 这一组**要网络 + ssh**(它的基线阳性对照就是真去问一次线上)。别的组离线能跑,
  // 它不能 —— 而这正是它守的那件事:一道扫不到线上的闸,答不了「用户在用哪一版」。
  deployed: {
    gate: "scripts/check-deployed-drift.mjs",
    title: "check-deployed-drift(366,线上对账)",
    knives: [
      { n: "① 官网线上与仓里 site/index.html 不同", expect: "线上与 site/index.html 不同",
        note: "逐字节而不是只比版本号:360-362 那三笔漂的是整段内容,版本号那一格照样能全绿",
        edits: [["site/index.html", "<html lang=\"zh\">", "<html lang=\"zh\"> "]] },
      { n: "② 桌面清单版本对不上", expect: "≠ 仓里",
        edits: [["package.json", '"version": "', '"version": "9.']] },
      { n: "③ 安卓 versionCode 对不上", expect: "≠ 按",
        edits: [["android/package.json", '"version": "0.3.', '"version": "0.4.']] },
      { n: "④ deploy.md 那张表的「服务器」行被挪走(地址读不出 = 不许猜)",
        expect: "读不出服务器地址",
        edits: [["docs/deploy.md", "| 服务器 | `", "| 服务器地址 | `"]] },
      // ⑤-⑧ 换的是**门禁的输入**不是仓里的文件:线上好着的时候,下面四条分支在真跑里
      // 一条都到不了(不可达的防护 = 没被验过的代码)。注入模式恒 exit 1,故这四刀
      // 全靠 expect 那句话判 —— 退出码在这里不携带信息。
      { n: "⑤ 线上跑的是脏构建", expect: "脏构建",
        env: { ZJ_DRIFT_FAKE_SYNCD: '{"commit":"ab62d0df12c4","dirty":true,"built_at":"x","pkg_version":"0.1.0"}' } },
      { n: "⑥ 线上 commit 本机仓里没有", expect: "本机仓里没有",
        env: { ZJ_DRIFT_FAKE_SYNCD: '{"commit":"dead0000beef","dirty":false,"built_at":"x","pkg_version":"0.1.0"}' } },
      { n: "⑦ 线上落后(server/ 有已提交未部署的改动)", expect: "线上落后",
        note: "锚是仓里第一笔 server/ 提交(639cc5d,计费工序 1),它恒落后于 HEAD",
        env: { ZJ_DRIFT_FAKE_SYNCD: '{"commit":"639cc5d75d93","dirty":false,"built_at":"x","pkg_version":"0.1.0"}' } },
      { n: "⑧ 回体不合形(commit 不是 12 位 hex)", expect: "commit 不合形",
        note: "build.rs 那句 fail-fast 的另一半:真出现 unknown 这种占位串,门禁必须当场红",
        env: { ZJ_DRIFT_FAKE_SYNCD: '{"commit":"unknown","dirty":false,"built_at":"x","pkg_version":"0.1.0"}' } },
    ],
  },
};

// ---- 跑 ------------------------------------------------------------------------------

const picked = want === "all" ? Object.keys(SUITES) : [want];
for (const name of picked) {
  if (!SUITES[name]) {
    console.error(`没有这一组:${name}(有 ${Object.keys(SUITES).join(" / ")} / all)`);
    process.exit(2);
  }
}

let bad = 0, ran = 0, skipped = 0;

for (const name of picked) {
  const suite = SUITES[name];
  console.log(`${NL}=== ${suite.title} ===`);

  // 阳性对照:基线必须绿。不绿的话后面每一刀的红都说明不了任何事。
  const base = run(suite.gate);
  if (base.code !== 0) {
    console.error(`✗ 基线就不是绿的:${NL}${base.out}`);
    process.exit(2);
  }
  console.log("✓ 阳性对照:基线绿(exit 0)");

  // k.tool 可以是 "xcheck"(本组那只要 Chrome 的对拍)、也可以直接写一只脚本路径。
  // ⚠ 写了别的工装就得给它也跑一次阳性对照:一只**恒红**的工装会让它下面每一刀都
  // 「红得很好看」而其实什么都没验(339 那条「跑手自己也要有阳性对照」的教训)。
  const toolOf = (k) => (k.tool === "xcheck" ? suite.xcheck : k.tool || suite.gate);
  for (const extra of new Set(suite.knives.map(toolOf).filter((x) => x !== suite.gate && x !== suite.xcheck))) {
    if (run(extra).code !== 0) {
      console.error(`✗ 阳性对照破:工装 ${extra} 在**没动任何东西**时就是红的,它下面的刀全部作废`);
      process.exit(2);
    }
    console.log(`✓ 阳性对照:${extra} 基线绿`);
  }

  for (const k of suite.knives) {
    const tool = toolOf(k);
    if (k.tool === "xcheck" && !withChrome) {
      console.log(`—  ${k.n}(要 Chrome,带 --with-chrome 才跑)`);
      skipped++;
      continue;
    }
    const saved = new Map();
    try {
      for (const [file, from, to] of k.edits ?? []) {
        const p = F(file);
        if (!saved.has(p)) saved.set(p, readFileSync(p, "utf8"));
        const cur = readFileSync(p, "utf8");
        // 锚点找不到 = 这一刀根本没下去。**必须当场报**:它与「注入了但门禁没红」在
        // 输出上长得一样,而后者才是真发现。
        if (!cur.includes(from)) throw new Error(`这一刀下不去:${file} 里找不到「${from.slice(0, 46)}」`);
        writeFileSync(p, cur.replace(from, to));
      }
      const r = run(tool, k.env);
      ran++;
      const marks = r.out.split(NL).filter((l) => l.trim().startsWith("✗") || l.includes("DIFF"));
      const red = r.code > 0;
      const expects = Array.isArray(k.expect) ? k.expect : [k.expect];
      const missing = expects.filter((e) => !r.out.includes(e));
      if (!red) {
        bad++;
        console.log(`✗ 没红          ${k.n}`);
      } else if (r.code === -1) {
        bad++;
        console.log(`✗ 假红(工装自己崩了)  ${k.n}${NL}    ${r.out.split(NL)[0]}`);
      } else if (missing.length) {
        bad++;
        console.log(`✗ 红错了地方    ${k.n}${NL}    缺 [${missing.join(" / ")}] —— 这一刀证不了它该证的那条规则`);
        for (const m of marks.slice(0, 2)) console.log(`    ${m.trim().slice(0, 150)}`);
      } else {
        console.log(`✓ 真红          ${k.n}`);
      }
      if (k.note) console.log(`     ${k.note}`);
    } catch (e) {
      bad++;
      console.log(`✗ 这一刀本身出错  ${k.n}${NL}    ${e.message}`);
    } finally {
      for (const [p, text] of saved) writeFileSync(p, text);
    }
    // 还原干净了没有:复证基线又绿(否则后一刀会吃前一刀的残留)
    const back = run(suite.gate);
    if (back.code !== 0) {
      bad++;
      // ⚠ **别把这句话说死成「残留」**(366 判例):这道复证会因为**别的**原因不绿 —— deployed
      // 组的门禁要走网络,一次瞬时抖动就让它红,而「这一刀漏了什么没擦掉」是个**自信的错答案**
      // (与 338 那条「catch 的兜底值把工装自己坏了伪装成被测对象的问题」同族)。所以把门禁
      // 当时说了什么原样印出来,让人自己看是残留还是别的。
      console.log(`✗ 还原之后基线不绿了  ${k.n} —— 可能是这一刀漏了什么没擦掉,也可能是别的:`);
      for (const l of back.out.split(NL).filter((l) => l.includes("FAIL") || l.trim().startsWith("✗"))) {
        console.log(`    ${l.trim().slice(0, 160)}`);
      }
    }
  }
}

console.log(
  `${NL}${bad ? `✗ ${ran} 刀里 ${bad} 刀有问题。` : `✓ ${ran} 刀全部真红,且全红在该红的地方。`}` +
    (skipped ? `(另 ${skipped} 刀要 Chrome,没跑)` : ""),
);
process.exit(bad ? 1 : 0);
