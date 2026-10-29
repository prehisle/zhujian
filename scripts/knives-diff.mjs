#!/usr/bin/env node
// 长文历史比对单测(scripts/test-diff.mjs)的阴性对照。每刀 = 一个**该被逮到**的改坏:
// 注入后单测必须真红、且红的正是该刀点名的那几条。跑完原样还回去(finally,中途崩了也还)。
// 跑法:node scripts/knives-diff.mjs
//
// 判「逮到了」的三条同 knives-markdown.mjs:①刀恰好命中一处;②看得到 `# pass` / `# fail` 两行;
// ③点名的每一条都在 `not ok` 里。
// ⚠ **没有「撤内存闸」这一刀**:在现在这组数下内存闸够不着 —— D 层 trace 的对角线数 ≈ D²/2,
// 每条至少记一个工作单位,工作预算总比 8 MiB 先到(字级最贵那一对:工作在 D≈2000 到顶,
// 内存要 D≈2032 才到)。撤掉它单测照样绿,这是数决定的,不是没守。哪天调高工作预算或 D 上限,
// 内存闸才变得够得着,那时补刀。「trace 不紧凑」那一刀守的是另一件事:每层只存有效对角线。
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DIFF = "shared/diff.ts";
const DOM = "shared/diff-dom.ts";

const KNIVES = [
  {
    name: "撤工作预算",
    file: DIFF,
    from: 'if (cx.stats.work > DIFF_MAX_WORK) throw new Over("work");',
    to: 'if (false) throw new Over("work");',
    red: ["字级工作预算:贵的一对超了 ⇒ 行级保留、这一对及其后不细化、标「受限」"],
  },
  {
    name: "撤行级 D 上限",
    file: DIFF,
    from: 'if (d > maxD) throw new Over("depth");',
    to: 'if (false) throw new Over("depth");',
    red: ["行级 D 上限:全异长文在 1,024 层停,trace 是紧凑的", "DOM:受限照画、标出来;降级画两份原文"],
  },
  {
    name: "trace 每层存满 2d+1 条对角线",
    file: DIFF,
    from: "const cur = i32(cx, d + 1);",
    to: "const cur = i32(cx, 2 * d + 1);",
    red: ["行级 D 上限:全异长文在 1,024 层停,trace 是紧凑的"],
  },
  {
    name: "改回码元切分",
    file: DIFF,
    from: "const at = (i: number): number => s.codePointAt(i)!;",
    to: "const at = (i: number): number => s.charCodeAt(i);",
    red: [
      "字级最短:配对行内删增码点数 = 朴素码点编辑距离",
      "码点:代理对不劈开,组合 / ZWJ / 旗帜原文精确还原",
      "字级资格:两侧都 ≤ DIFF_MAX_CP 个码点才细化(按码点不按 .length;行尾换行也算一个)",
    ],
  },
  {
    name: "字级资格不数码点",
    file: DIFF,
    from: "if (n > DIFF_MAX_CP) return null;",
    to: "if (false) return null;",
    red: ["字级资格:两侧都 ≤ DIFF_MAX_CP 个码点才细化(按码点不按 .length;行尾换行也算一个)"],
  },
  {
    name: "不等长也逐行配对",
    file: DIFF,
    from: "if (p !== q) {",
    to: "if (p === 0 || q === 0) {",
    red: ["配对:段内删增等长才逐行配对,不等长整段删在前、增在后"],
  },
  {
    name: "平局改取右移",
    file: DIFF,
    from: "return rt + 1 <= dn;",
    to: "return rt + 1 < dn;",
    red: ["平局:重复行与交换的结果钉死(同一段里删在前)"],
  },
  {
    name: "比之前把 CRLF 统一成 LF",
    file: DIFF,
    from: "const la = splitLines(a);",
    to: 'const la = splitLines(a.replace(/\\r\\n/g, "\\n"));',
    red: ["还原:行结束符、末尾换行、CRLF 都是真差异,两侧逐码元拼回", "行级最短:随机小输入与朴素 LCS 对拍,删增行数 = 编辑距离"],
  },
  {
    name: "撤输出节点预算",
    file: DIFF,
    from: "if (nodes + c > DIFF_MAX_DOM) throw new NodesOver();",
    to: "if (false) throw new NodesOver();",
    red: ["输出节点预算按整份合计,不按改动段各给一份;与渲染器对拍"],
  },
  {
    name: "节点账与渲染器对不上",
    file: DIFF,
    from: 'if (r.t !== "pair") return 2;',
    to: 'if (r.t !== "pair") return 1;',
    red: ["输出节点预算按整份合计,不按改动段各给一份;与渲染器对拍"],
  },
  {
    name: "整行用 innerHTML 画",
    file: DOM,
    from: "      e.append(txt(cx, x.s));\n",
    to: "      count(cx);\n      e.innerHTML = x.s;\n",
    red: ["DOM:只有固定标签与 class,正文全进文本节点,不渲染 Markdown"],
  },
];

const orig = { [DIFF]: fs.readFileSync(DIFF, "utf8"), [DOM]: fs.readFileSync(DOM, "utf8") };
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
      out = execFileSync(process.execPath, ["scripts/test-diff.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
  for (const f of [DIFF, DOM]) fs.writeFileSync(f, orig[f]);
}
console.log(bad === 0 ? `${KNIVES.length} 把刀全逮到` : `${bad} / ${KNIVES.length} 把刀没逮到`);
process.exit(bad === 0 ? 0 : 1);
