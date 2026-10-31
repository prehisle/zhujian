#!/usr/bin/env node
// 长文 Markdown 单测(scripts/test-markdown.mjs)的阴性对照。每刀 = 一个**该被逮到**的改坏:
// 注入后单测必须真红、且红的正是该刀点名的那几条。跑完原样还回去(finally,中途崩了也还)。
// 跑法:node scripts/knives-markdown.mjs
//
// 判「逮到了」的三条(knives-checklist-input.mjs 栽过的坑,照搬):
//   ①刀必须**恰好命中一处**(0 处 = 没落上,>1 处 = 有一处没人守);
//   ②必须看到 `# pass` / `# fail` 两行 —— 刀带进语法错时单测一条都没跑,退出码同样是 1;
//   ③点名的每一条都得在 `not ok` 里,光「有红」不算。
// ⚠ 「逐开符扫后缀」那刀里的扫描**是记数的**:计数器只看得见记数的循环,一个不记数的平方扫描
// 在这里只剩墙钟烟测能碰(200 KiB 下约百毫秒级,碰不到 2 秒那条线)。所以「每个逐字循环都记数」
// 是评审要盯的,不是本脚本能证明的。
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const MD = "shared/markdown.ts";
const DOM = "shared/markdown-dom.ts";

const KNIVES = [
  {
    name: "撤节点预算",
    file: MD,
    from: 'if (cx.nodes >= MD_MAX_NODES) throw new Over("nodes");',
    to: 'if (false) throw new Over("nodes");',
    red: ["节点预算:超了整篇降级,不留半截"],
  },
  {
    name: "撤深度预算",
    file: MD,
    from: 'if (depth > MD_MAX_DEPTH) throw new Over("depth");',
    to: 'if (false) throw new Over("depth");',
    red: ["深度预算:所有节点都计"],
  },
  {
    name: "反引号改成逐开符往后扫",
    file: MD,
    from: "  const closerAt = (len: number, from: number): number => {\n",
    to:
      "  const closerAt = (len: number, from: number): number => {\n" +
      "    for (let p = from; p < n; p++) {\n" +
      "      st.scanned++;\n" +
      "      if (src.charCodeAt(p) !== 96) continue;\n" +
      "      let q = p;\n" +
      "      while (q < n && src.charCodeAt(q) === 96) { st.scanned++; q++; }\n" +
      "      if (q - p === len) return p;\n" +
      "      p = q;\n" +
      "    }\n" +
      "    return -1;\n",
    red: ["资源族「不同长度反引号串」:计数器 ≤ 24·n + 4096,输出对"],
  },
  {
    name: "链接目标放行 ](试配区间不再两两不交)",
    file: MD,
    from: "if (nextWs![s] < e || nextRb![s] < e) return null;",
    to: "if (nextWs![s] < e) return null;",
    red: ["资源族「嵌套括号的目标」:计数器 ≤ 24·n + 4096,输出对", "链接:合法的成链接,不合法的整段原文"],
  },
  {
    name: "校验器放行别的协议",
    file: MD,
    from: 'if (u.protocol !== "http:" && u.protocol !== "https:") return null;',
    to: 'if (u.protocol === "ftp:") return null;',
    red: [
      "校验器:别的协议、相对地址、控制字符、超长一律拒",
      "链接:合法的成链接,不合法的整段原文",
      "恶意输入:所有字段只进固定标签 / 文本节点 / 闭包",
    ],
  },
  {
    name: "校验器不拒控制字符",
    file: MD,
    from: "if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return null;",
    to: "if (false) return null;",
    red: ["校验器:别的协议、相对地址、控制字符、超长一律拒"],
  },
  {
    name: "校验器不验规范化后的长度(自己的输出再验会被拒)",
    file: MD,
    from: "if (u.href.length > URL_MAX_LEN) return null;",
    to: "if (false) return null;",
    red: ["校验器对自己的输出闭合:规范化后变长的地址也点得开(codex 2a 一弹 M)"],
  },
  {
    name: "_ 的贴字判断只看半个代理对",
    file: MD,
    from: "WORD.test(codePointBefore(src, i))",
    to: "WORD.test(src[i - 1])",
    red: ["粗斜:中文贴字成立、snake_case 不斜、三连当原文、最多两层"],
  },
  {
    name: "渲染器给链接写 href",
    file: DOM,
    from: "  a.tabIndex = 0;\n",
    to: "  a.tabIndex = 0;\n  (a as HTMLAnchorElement).href = url;\n",
    red: ["恶意输入:所有字段只进固定标签 / 文本节点 / 闭包"],
  },
  {
    name: "原位图:段里夹了字也算图段",
    file: DOM,
    from: '    if (x.t === "text" && x.s.trim() === "") continue;\n',
    to: '    if (x.t === "text") continue;\n',
    red: ["写到哪画到哪:每张图只画一次,画在第一次提到它的地方;句中的画在那一块下面;src 只取钩子交回的串"],
  },
  {
    name: "原位图:src 拿文案顶替钩子交回的图址",
    file: DOM,
    from: '    if (typeof src === "string") pic.src = src;\n',
    to: '    if (typeof src === "string") pic.src = img.label;\n',
    red: ["写到哪画到哪:每张图只画一次,画在第一次提到它的地方;句中的画在那一块下面;src 只取钩子交回的串"],
  },
  {
    name: "原位图:不记已画过的图号(同一张提几次画几张)",
    file: DOM,
    from: "    cx.drawn.add(ns[i]);\n",
    to: "",
    red: ["写到哪画到哪:每张图只画一次,画在第一次提到它的地方;句中的画在那一块下面;src 只取钩子交回的串"],
  },
  {
    name: "原位图:句中提到的不画在那一块下面",
    file: DOM,
    from: "  if (imgs.length === 0) return e;\n",
    to: "  return e;\n",
    red: ["写到哪画到哪:每张图只画一次,画在第一次提到它的地方;句中的画在那一块下面;src 只取钩子交回的串", "图N 与方框:渲染器自己建,钩子只给文案与动作;查不到的图按原文"],
  },
  {
    name: "渲染器拿 innerHTML 画文字",
    file: DOM,
    from: '    case "text":\n      return txt(cx, x.s);\n',
    to: '    case "text": {\n      const sp = mk(cx, "span");\n      sp.innerHTML = x.s;\n      return sp;\n    }\n',
    red: ["恶意输入:所有字段只进固定标签 / 文本节点 / 闭包"],
  },
  {
    name: "撤 DOM 预算",
    file: DOM,
    from: "if (cx.n >= MD_MAX_DOM) throw new DomOver();",
    to: "if (false) throw new DomOver();",
    red: ["DOM 预算:语法树没超而 DOM 超了也整篇降级"],
  },
];

const orig = { [MD]: fs.readFileSync(MD, "utf8"), [DOM]: fs.readFileSync(DOM, "utf8") };
let bad = 0;
try {
  for (const k of KNIVES) {
    const src = orig[k.file];
    const hits = src.split(k.from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${k.name}:刀口命中 ${hits} 处(须恰 1 处)—— 源码改了,刀要跟着改`);
      bad++;
      continue;
    }
    fs.writeFileSync(k.file, src.replace(k.from, () => k.to));
    let out = "";
    try {
      out = execFileSync(process.execPath, ["scripts/test-markdown.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    fs.writeFileSync(k.file, src);
    const ran = /^# pass \d+/m.test(out) && /^# fail \d+/m.test(out);
    const red = new Set([...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()));
    const missed = k.red.filter((t) => !red.has(t));
    if (!ran) {
      console.log(`✗ ${k.name}:单测没跑起来(多半是刀带进了语法错),不算逮到`);
      bad++;
    } else if (missed.length > 0) {
      console.log(`✗ ${k.name}:这几条没红 —— ${missed.join(" / ")}`);
      bad++;
    } else {
      console.log(`✓ ${k.name}:红了 ${red.size} 条,点名的 ${k.red.length} 条都在`);
    }
  }
} finally {
  for (const f of [MD, DOM]) fs.writeFileSync(f, orig[f]);
}
console.log(bad === 0 ? `${KNIVES.length} 把刀全逮到` : `${bad} / ${KNIVES.length} 把刀没逮到`);
process.exit(bad === 0 ? 0 : 1);
