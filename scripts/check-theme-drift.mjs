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

/** 三份令牌表。`dark` = 这一份有没有暗色档。 */
const SOURCES = [
  { name: "桌面", file: "src/theme.css", dark: true },
  { name: "安卓", file: "android/index.html", dark: true },
  // 官网刻意不做明暗三档(静态单页、无偏好持久化),故只有亮色一档。
  { name: "官网", file: "site/index.html", dark: false },
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

  // ---- 字体:三份同字栈;暗色不重定义(字体与明暗无关) ----
  { name: "--font-sans", in: ALL, dark: false },
  { name: "--font-serif", in: ALL, dark: false },

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
    in: ["安卓"],
    dark: true,
    why: "「成功/正向」绿,今天只有安卓的同步状态点在用。桌面若要用同一个语义色,\
应当把它提到 in: APPS 并把值抄过去,而不是另起一个名字",
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

/** 一份文件里的令牌:{ light: {名:值}, dark: {名:值} }。值做空白折叠后逐字比对。 */
function tokensOf(text, file) {
  const pick = (body) => {
    const bag = {};
    if (body === null) return bag;
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      bag[m[1]] = m[2].trim().replace(/\s+/g, " ");
    }
    return bag;
  };
  // `:root {` 与 `:root{` 两种写法都认;暗色一律挂 [data-theme="dark"](theme-mode 单点写属性)。
  const lightBody = blockBody(text, ":root {") ?? blockBody(text, ":root{");
  if (lightBody === null) throw new Error(`${file} 里找不到 :root { … } 块 —— 令牌表搬走了?`);
  return { light: pick(lightBody), dark: pick(blockBody(text, ':root[data-theme="dark"]')) };
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
  if (s.dark && Object.keys(t.dark).length === 0) {
    problems.push(`${s.name}(${s.file})声称有暗色档,却一个暗色令牌都没解析到`);
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
