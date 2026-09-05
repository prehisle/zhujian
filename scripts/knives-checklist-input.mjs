// 待办清单快速输入(562)的阴性对照。每刀 = 一个**该被逮到**的改动:注入后
// check-filter-parity 必须真红、且红的正是该规则那几格。跑完原样还回去。
//
// ⚠ 三处是前两版栽出来的:①「刀落上了吗」不能用 `git diff`(本轮这文件本来就是改过
// 的,numstat 恒答 124 行、刀落没落上屏幕上同形)—— 改成拿写进去的内容与 orig 直接比;
// ②「退出码 1」不等于「用例逮到了」:有把刀带进语法错,闸构建就炸了、一格用例都没跑,
// 屏幕上同样是「退出码 1」⇒ 须认「N 条全过 / N 条不符」那行确实出现过;③第一把「起一条I」
// 砍的是 clamp 整体,而目标那格在两种写法下**序列化结果相同** ⇒ 刀逮不到不等于代码没护住,
// 换成砍下限 `lo→0` 并补一格能观测的用例(摘标记时光标跑到上一行)。
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const F = "src/checklist.ts";
const orig = fs.readFileSync(F, "utf8");

const KNIVES = [
  ["续行A 不是待办项也接管(该逮到:普通正文 / 裸 `- 文字` 该 null)",
    "  if (parsed === null) return null;\n  if (parsed.rest.trim()",
    "  if (parsed === null) return { value, selStart, selEnd };\n  if (parsed.rest.trim()"],
  ["续行B 空项上照常插新项(该逮到:退出清单那三格)",
    "  if (parsed.rest.trim() === \"\") {",
    "  if (false) {"],
  ["续行C 续出的项不带缩进(该逮到:两格缩进用例)",
    "${parsed.indent}${MARK}",
    "${MARK}"],
  ["续行D 光标在标记里也接管(该逮到:那一格 null)",
    "  if (selStart < ls + parsed.indent.length + MARK.length) return null;",
    "  if (false) return null;"],
  ["续行E 选中一段也接管(该逮到:选区那格 null)",
    "  if (selStart !== selEnd) return null;",
    "  if (false) return null;"],
  ["起一条F 方向只看第一行(该逮到:混排整块都加那格)",
    "  const add = judged.some((l) => parseChecklistLine(l) === null);",
    "  const add = parseChecklistLine(judged[0] ?? \"\") === null;"],
  ["起一条G 多行里的空行也加标记(该逮到:空行原样那格)",
    "    if (multi && l.trim() === \"\") return l;",
    "    if (false) return l;"],
  ["起一条H 摘标记顺手把前导空白全去掉(该逮到:多打的空格该留着)",
    "${p.indent}${p.rest.replace",
    "${p.indent}${p.rest.trimStart()}${\"\".replace"],
  // ⚠ 600 起这把砍的是**两处共用**的那个算子(`lineClamp`)——「起一条」与「缩进」
  // 原本各写一份一模一样的夹取,而 `String.replace` 只换第一处 ⇒ 后写的那份会无声无息
  // 地没人守。提成一份之后这一刀该同时红在两族用例上。
  ["共用I 单行选区的下限用 0 而不是本行行首(该逮到:摘掉 / 反缩进时光标跑到上一行)",
    "Math.max(ls, x + delta)",
    "Math.max(0, x + delta)"],
  ["起一条K lineBoundsAt 不短路 pos===0(该逮到:首字符是换行那格)",
    "const start = pos === 0 ? 0 : value.lastIndexOf",
    "const start = value.lastIndexOf"],
  ["区间J 后缀回头吃掉前缀已认的部分(该逮到:重复字符那两格)",
    "    s < before.length - p &&\n    s < after.length - p &&",
    "    s < before.length &&\n    s < after.length &&"],
  // 缩进 / 反缩进(600)。⭐ 头两把守的是**别把 Tab 吃掉**那条命 —— 它是键盘用户离开
  // 输入框的唯一通路,接管面宽一寸就是把人关在框里,而那种坏法在界面上一声不响。
  ["缩进L 不涉及待办项也接管(该逮到:普通正文 / 裸 `- 文字` / 整块普通正文那三格 null)",
    "  if (!lines.some((l) => parseChecklistLine(l) !== null)) return null;",
    "  if (false) return null;"],
  ["缩进M 一个字都没变也接管(该逮到:两格「已经顶格 → null」)",
    "  if (out.every((l, i) => l === lines[i])) return null;",
    "  if (false) return null;"],
  ["缩进N 反缩进不看实有的缩进、一律削满一级(该逮到:只缩一个空格 / 制表符那两格)",
    "  return Math.min(INDENT.length, leadingIndent(line).length);",
    "  return INDENT.length;"],
  ["缩进O 多行里的空行也跟着推(该逮到:空行原样那格)",
    "    if (l.trim() === \"\") return l;\n    return deeper",
    "    if (false) return l;\n    return deeper"],
  ["缩进P 一级只推一个空格(该逮到:用户拍板的两个空格那几格)",
    "const INDENT = \"  \";",
    "const INDENT = \" \";"],
];

let bad = 0;
for (const [name, from, to] of KNIVES) {
  console.log(`\n—— ${name}`);
  if (!orig.includes(from)) { console.log("   💥 锚点没命中,这刀根本没落上 —— 先修刀再谈红绿"); bad++; continue; }
  fs.writeFileSync(F, orig.replace(from, to), "utf8");
  console.log(`   刀落上了吗:${fs.readFileSync(F, "utf8") === orig ? "❌ 文件没变!" : "✓ 与基线不同"}`);
  let out = "", code = 0;
  try { out = execFileSync("node", ["scripts/check-filter-parity.mjs"], { encoding: "utf8" }); }
  catch (e) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); code = e.status ?? 1; }
  const ran = /\d+ 条全过|\d+\/\d+ 条不符/.test(out);
  const reds = out.split("\n").filter((l) => l.startsWith("❌ [桌面] "));
  console.log(`   闸真跑起来了吗:${ran ? "✓ 用例跑完了" : "❌ 没跑到用例(构建/加载就炸了)"} · 退出码 ${code} · 红 ${reds.length} 格`);
  for (const r of reds.slice(0, 6)) console.log(`     ${r.replace("❌ [桌面] ", "")}`);
  if (reds.length > 6) console.log(`     …另 ${reds.length - 6} 格`);
  if (!ran || reds.length === 0) { console.log("   ⚠⚠ 这刀没被逮到"); bad++; }
  fs.writeFileSync(F, orig, "utf8");
}
console.log(`\n还原核对:${fs.readFileSync(F, "utf8") === orig ? "✓ 与基线逐字相同" : "❌ 没还原干净!"}`);
console.log(bad === 0 ? `\n✅ ${KNIVES.length} 刀全被逮到` : `\n❌ ${bad}/${KNIVES.length} 刀没被逮到`);
process.exit(bad === 0 ? 0 : 1);
