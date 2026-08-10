#!/usr/bin/env node
// 设计令牌漂移门禁:仓里**三份**「纸与朱墨」令牌表必须逐字对齐。
//
//   桌面 src/theme.css      —— 真相源(两个窗口共用,最全)
//   安卓 android/index.html —— 内联 <style>(安卓是独立 npm 工程)
//   官网 site/index.html    —— 内联 <style>(纯静态单页,scp 部署)
//
// # 为什么是三份而不是一份
//
// 物理上合不成一份:官网是**静态单文件、scp 部署**,引用不了仓内别处的 CSS;安卓是
// **独立 vite 工程**,要引仓根的文件得动 `server.fs.allow` + rollup 输入 + tauri 打包
// 三处。最多做到「一份源 + 构建期复制到三处」,而复制出来的副本**照样会在有人手改时漂**
// —— 那时仍然需要这只门禁。所以先做必需的这件,物理合并是可选的后话。
//
// # 它挡的是什么(有真判例)
//
// `--font-serif` 在官网上从上线第一笔(94)起就把 `SimSun` 和 `Songti SC` 的顺序写反了,
// 而客户端那份从建仓起没变过 —— **两者从未一致过,三年没人发现**。同时装了两种宋体的
// 机器上官网与 app 的想法原文字体不是同一个。327 那轮做三份比对时才量出来,同轮改齐。
//
// 用法:node scripts/check-theme-drift.mjs
// 全对齐 = 退出 0;漂移 / 未登记的令牌 / 点名的文件缺失 = 非零响亮。
// 发版门禁之一(与 check-lock-drift 并列,见 docs/dev-and-testing.md 与 skill zhujian-ops)。

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 暗色档的两种挂法。客户端由 theme-mode 单点写 data-theme 属性(明暗三档要它);
 * 官网没有那一层,直接 @media 跟随系统。**两种都主动去找**,找到哪种算哪种。
 */
const DARK_FORMS = [':root[data-theme="dark"]', "@media (prefers-color-scheme: dark)"];

/**
 * 三份令牌表。`dark` = 这一份**应该**有暗色档 —— 它是个会被核对的断言,不是配置:
 * 声称有却找不到、或声称没有却找得到,两个方向都红。
 *
 * ⚠ 336 修正:官网原登记为 `dark: false`,理由写「刻意不做明暗三档」。**三档**
 * (自动/亮/暗 用户可选)确实没有 —— 那要偏好持久化;但它**有暗色档**。于是官网那
 * 12 个暗色令牌从上线起没被任何门禁看过(今天碰巧还对齐,靠的是运气不是这道闸)。
 * 同轮的阴性对照还量出:光把这里改对不够 —— 旧版把 `dark:false` 当**配置**用,谁翻
 * 回去都不会响。所以现在两个方向都核。
 */
const SOURCES = [
  { name: "桌面", file: "src/theme.css", dark: true },
  { name: "安卓", file: "android/index.html", dark: true },
  { name: "官网", file: "site/index.html", dark: true },
];

const ALL = SOURCES.map((s) => s.name);
const APPS = ["桌面", "安卓"]; // 两个客户端(官网除外)

// 全部令牌的登记表。**新增令牌 = 这里加一行**,否则门禁当场拒(逼人当场决定它归谁)。
//   in   —— 哪几份**应该**有它;不是 ALL 的必须写 why
//   dark —— 暗色档要不要也定义一份(实际比对的份集 = in ∩ 支持暗色的份)
const TOKENS = [
  // ---- 表面 / 墨 / 发丝线 / 朱砂:三份必须逐字相同,这是「同一个产品」的视觉底座 ----
  { name: "--paper", in: ALL, dark: true },
  { name: "--raised", in: ALL, dark: true },
  { name: "--raised-edge", in: ALL, dark: true },
  { name: "--ink", in: ALL, dark: true },
  { name: "--ink-soft", in: ALL, dark: true },
  { name: "--ink-faint", in: ALL, dark: true },
  { name: "--line", in: ALL, dark: true },
  { name: "--line-strong", in: ALL, dark: true },
  { name: "--seal", in: ALL, dark: true },
  { name: "--seal-tint", in: ALL, dark: true },
  { name: "--seal-line", in: ALL, dark: true },
  // 压在朱砂上的字。336 之前三份各写各的白(桌面 #fdf6ee / 安卓 #fff / 官网 #faf6ec)——
  // 令牌表逐字对齐,用法却是三个值,那正是这道门禁看不见的那一层(现由 check-contrast 管)。
  { name: "--on-seal", in: ALL, dark: true },

  // ---- 字体:三份同字栈;暗色不重定义(字体与明暗无关) ----
  { name: "--font-sans", in: ALL, dark: false },
  { name: "--font-serif", in: ALL, dark: false },

  // ---- 圆角阶(341):三份同阶;暗色不重定义(几何与明暗无关) ----
  // 用法那一层由 `scripts/check-radius-drift.mjs` 管(这道只核定义)。
  { name: "--radius-xs", in: ALL, dark: false },
  { name: "--radius-sm", in: ALL, dark: false },
  { name: "--radius-md", in: ALL, dark: false },
  { name: "--radius-lg", in: ALL, dark: false },
  { name: "--radius-pill", in: ALL, dark: false },
  { name: "--radius-circle", in: ALL, dark: false },
  { name: "--radius-seal", in: ALL, dark: false },

  // ---- 字号阶(342):三份同阶;暗色不重定义(字号与明暗无关) ----
  // 用法那一层由 `scripts/check-fs-drift.mjs` 管(这道只核定义)。
  // 最小档 12px 不是随手取的:它就是 §2.2 第一条「信息性文字最小 12px」,阶下无档。
  { name: "--fs-12", in: ALL, dark: false },
  { name: "--fs-13", in: ALL, dark: false },
  { name: "--fs-14", in: ALL, dark: false },
  { name: "--fs-15", in: ALL, dark: false },
  { name: "--fs-16", in: ALL, dark: false },
  { name: "--fs-17", in: ALL, dark: false },
  { name: "--fs-18", in: ALL, dark: false },
  { name: "--fs-20", in: ALL, dark: false },
  { name: "--fs-24", in: ALL, dark: false },
  { name: "--fs-30", in: ALL, dark: false },

  // ---- 各端专用 / 尚未铺到的:逐条写明归谁、为什么 ----
  {
    name: "--card-shadow",
    in: ["桌面", "官网"],
    dark: true,
    why: "安卓的卡片用发丝线描边而不是投影(移动端小屏上投影会糊成一片),故它那份没有这一格",
  },
  {
    name: "--float-shadow",
    in: ["桌面", "官网"],
    dark: true,
    why: "同 --card-shadow:安卓的浮层贴边或全屏,不做悬浮投影",
  },
  {
    name: "--grain",
    in: ["桌面", "官网"],
    dark: false,
    why: "纸纹噪点是桌面窗口与官网大版面的质感;手机屏小、且那张 SVG 每帧重绘不划算,安卓没铺",
  },
  {
    name: "--font-brush",
    in: ["官网"],
    dark: false,
    why: "楷体品牌字面,只用在官网标题(app 内不做第三层字面,界面里楷体可读性差)",
  },
  {
    name: "--wrap",
    in: ["官网"],
    dark: false,
    why: "官网单页的内容区最大宽度,是布局尺寸不是颜色令牌;app 侧宽度由窗口/屏幕定",
  },
  {
    name: "--ok",
    in: APPS,
    dark: true,
    why: "「成功/正向」绿,两个客户端的同步状态点「已连」在用。339 兑现了上一版这条 why 里\
写的话 —— 桌面此前写死 #4c9a6a 且两档同一个值,已把安卓那份的值抄过来。官网没有同步状态",
  },
  {
    name: "--wc-w",
    in: ["桌面"],
    dark: false,
    why: "单颗自绘窗控按钮的宽(notebook 壳 .wc)。344 收:此前 46px 写在壳里、而各视图头\
「右侧躲开 3×46=138px」那笔账只存在于三处复制的注释里,窗控加宽会让视图头静默钻底。\
安卓/官网没有自绘窗控。与 --wrap 同族:布局尺寸不是颜色令牌",
  },
  {
    name: "--winctl-dead",
    in: ["桌面"],
    dark: false,
    why: "窗控死区 = calc(3 × --wc-w) = 138px,四个视图头的右 padding 从它派生(+ 各自的\
呼吸量)。派生常量不是审美值 —— 344 有意只把这类跨文件派生约束收成令牌,间距不建阶\
(判据分析见 progress-log 344)",
  },
  {
    name: "--nav-clear",
    in: ["安卓"],
    dark: false,
    why: "悬浮层给底栏让出的高度(64px 眼估余量,实高约 57px+安全区):此前 body 底 padding /\
更新条 / 确认条三处各写死一份、上次底栏改高人工追改过一轮。与 --winctl-dead 同族:跨处派生\
约束收成令牌(344 的形)。FAB 走 ResizeObserver 实测的 --nav-h,两套的合并待拍板",
  },
];

// ---- 解析 ---------------------------------------------------------------------------

/** 取出 `选择器 { … }` 那一块的块体(花括号配平);找不到返回 null。 */
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
  // 配不平 = 看不懂的形状,一律响亮(别猜)。
  throw new Error(`${selector} 的 { 没有配平的 } —— 解析器看不懂这个形状`);
}

/** 一份文件里的令牌:{ light, dark, darkForm }。值做空白折叠后逐字比对。 */
function tokensOf(text, file) {
  const pick = (body) => {
    const bag = {};
    if (body === null) return bag;
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      bag[m[1]] = m[2].trim().replace(/\s+/g, " ");
    }
    return bag;
  };
  // `:root {` 与 `:root{` 两种写法都认。
  const lightBody = blockBody(text, ":root {") ?? blockBody(text, ":root{");
  if (lightBody === null) throw new Error(`${file} 里找不到 :root { … } 块 —— 令牌表搬走了?`);
  // 两种挂法都探,别听登记表说 —— 「这份有没有暗色档」自己就是要被核的那件事。
  for (const form of DARK_FORMS) {
    let darkBody = blockBody(text, form);
    if (darkBody === null) continue;
    if (form.startsWith("@media")) {
      darkBody = blockBody(darkBody, ":root {") ?? blockBody(darkBody, ":root{");
    }
    const dark = pick(darkBody);
    if (Object.keys(dark).length > 0) return { light: pick(lightBody), dark, darkForm: form };
  }
  return { light: pick(lightBody), dark: {}, darkForm: null };
}

// ---- 门禁 ---------------------------------------------------------------------------

const problems = [];
const parsed = new Map();

for (const s of SOURCES) {
  // 缺文件不吞:点名的文件必须在(fail-fast,别让门禁静默变窄)。
  const text = readFileSync(resolve(root, s.file), "utf8");
  const t = tokensOf(text, s.file);
  // 反向探针:哪份都不该解析出空表。正则或选择器写错时这一条第一个响。
  if (Object.keys(t.light).length === 0) {
    problems.push(`${s.name}(${s.file})的 :root 里一个令牌都没解析到 —— 提取器失灵,不是那里真的空着`);
  }
  // `dark` 是断言不是配置,两个方向都核 —— 336 的阴性对照证明:只把登记改对不够,
  // 旧版把它当配置用,谁翻回 false 都不会响,那 12 个暗色令牌就又静默出局了。
  if (s.dark && t.darkForm === null) {
    problems.push(`${s.name}(${s.file})登记为有暗色档,却两种挂法(${DARK_FORMS.join(" / ")})都没找到`);
  }
  if (!s.dark && t.darkForm !== null) {
    problems.push(
      `${s.name}(${s.file})登记为没有暗色档,却在 ${t.darkForm} 里找到了 ` +
        `${Object.keys(t.dark).length} 个暗色令牌 —— 那它们从来没被比对过,改登记表`,
    );
  }
  parsed.set(s.name, t);
}

const registered = new Set(TOKENS.map((t) => t.name));

// ① 登记表自身的卫生:名字不重、非全集的必须写理由、in 里的名字得是真的份。
const seen = new Set();
for (const tk of TOKENS) {
  if (seen.has(tk.name)) problems.push(`TOKENS 里 ${tk.name} 出现了两次`);
  seen.add(tk.name);
  for (const who of tk.in) {
    if (!ALL.includes(who)) problems.push(`${tk.name} 的 in 里有不存在的份「${who}」`);
  }
  if (tk.in.length !== ALL.length && !tk.why?.trim()) {
    problems.push(`${tk.name} 不是三份都有,却没写 why —— 空理由 = 没想过,不许过`);
  }
  if (tk.in.length === 0) problems.push(`${tk.name} 的 in 是空的 —— 那它什么都不守,删掉它`);
}

// ② 文件里出现但没登记的令牌 = 红(逼人当场决定它归谁,而不是又长出第四处漂移点)。
for (const s of SOURCES) {
  const t = parsed.get(s.name);
  for (const mode of ["light", "dark"]) {
    for (const name of Object.keys(t[mode])) {
      if (!registered.has(name)) {
        problems.push(
          `${s.name}(${s.file})的${mode === "light" ? "亮色" : "暗色"}档里有未登记的令牌 ${name}` +
            ` —— 新令牌要在 scripts/check-theme-drift.mjs 的 TOKENS 里登记(它归哪几份、为什么)`,
        );
      }
    }
  }
}

// ③ 该有的必须有且逐字相等;不该有的必须没有。
for (const tk of TOKENS) {
  for (const mode of ["light", "dark"]) {
    if (mode === "dark" && !tk.dark) {
      // 声明「暗色不重定义」的令牌,任何一份都不许偷偷定义一个暗色值(那是隐形分叉)。
      for (const s of SOURCES) {
        if (parsed.get(s.name).dark[tk.name] !== undefined) {
          problems.push(
            `${tk.name} 登记为「暗色不重定义」,但 ${s.name} 的暗色档里定义了它` +
              ` —— 要么改登记表(dark: true),要么删掉那一行`,
          );
        }
      }
      continue;
    }
    // 实际该有它的份 = in ∩(亮色所有份 / 暗色则再 ∩ 支持暗色的份)
    const expect = SOURCES.filter(
      (s) => tk.in.includes(s.name) && (mode === "light" || s.dark),
    ).map((s) => s.name);
    const values = new Map();
    for (const s of SOURCES) {
      const v = parsed.get(s.name)[mode][tk.name];
      const should = expect.includes(s.name);
      if (should && v === undefined) {
        problems.push(`${tk.name}(${mode === "light" ? "亮色" : "暗色"})在 ${s.name} 里缺失,登记表说它该有`);
      } else if (!should && v !== undefined) {
        problems.push(
          `${tk.name}(${mode === "light" ? "亮色" : "暗色"})出现在 ${s.name} 里,登记表说它不该有` +
            (tk.why ? `(理由:${tk.why})` : "") +
            ` —— 要么把 ${s.name} 加进 in,要么删掉那一行`,
        );
      } else if (should) {
        values.set(s.name, v);
      }
    }
    const uniq = [...new Set(values.values())];
    if (uniq.length > 1) {
      const lines = [...values.entries()].map(([n, v]) => `      ${v}   ← ${n}`).join("\n");
      problems.push(
        `${tk.name}(${mode === "light" ? "亮色" : "暗色"})三份不一致:\n${lines}\n` +
          `    —— 桌面 src/theme.css 是真相源,改这里就把另两份抄齐`,
      );
    }
  }
}

// ④ 反向探针下半:登记表里的每一项都得真的被至少一份用上(打错字的条目什么都不守)。
for (const tk of TOKENS) {
  const used = SOURCES.some(
    (s) => parsed.get(s.name).light[tk.name] !== undefined || parsed.get(s.name).dark[tk.name] !== undefined,
  );
  if (!used) {
    problems.push(`TOKENS 里的 ${tk.name} 今天一份都没在用:要么是打错了字(那它什么都不守),要么该删掉`);
  }
}

if (problems.length) {
  console.error("设计令牌漂移门禁:不过\n");
  for (const p of problems) console.error("  ✗ " + p);
  console.error(`\n共 ${problems.length} 处。`);
  process.exit(1);
}

const n = TOKENS.filter((t) => t.in.length === ALL.length).length;
console.log(
  `设计令牌门禁通过:${TOKENS.length} 个令牌已登记,其中 ${n} 个三份共有且逐字相同` +
    `(${SOURCES.map((s) => s.name).join(" / ")})。`,
);
