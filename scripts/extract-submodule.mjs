#!/usr/bin/env node
// 把 `<parent>.rs` 的一段连续行搬进 `<parent>/<name>.rs`,原处留一行 `mod <name>;`。
// 310 可维护性轮第 ② 笔的搬家工具(第 ① 笔的 extract-test-module.mjs 的生产段版)。
//
// 用法:node scripts/extract-submodule.mjs <parent.rs> <起行> <止行(不含)> <模块名> [--dry]
//
// fail-closed:区间越界 / 起行不是零缩进的注释或条目 / 止行不是零缩进 —— 一律拒绝。
// 搬完**不管可见性**:那要靠编译器指出来,脚本猜不得。
import fs from "node:fs";
import path from "node:path";

const [, , parent, aRaw, bRaw, name, ...flags] = process.argv;
const dry = flags.includes("--dry");
if (!parent || !aRaw || !bRaw || !name) {
  console.error("用法: node scripts/extract-submodule.mjs <parent.rs> <起行> <止行> <模块名> [--dry]");
  process.exit(1);
}
const a = Number(aRaw), b = Number(bRaw);

const src = fs.readFileSync(parent, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);

if (!(a >= 1 && b > a && b <= lines.length + 1)) {
  console.error(`区间 ${a}..${b} 越界(文件 ${lines.length} 行)—— 拒绝`);
  process.exit(1);
}
const first = lines[a - 1];
if (first.startsWith(" ") || first.startsWith("\t")) {
  console.error(`起行有缩进,不是顶层边界:${JSON.stringify(first)} —— 拒绝`);
  process.exit(1);
}
if (b <= lines.length) {
  const after = lines[b - 1];
  if (after.startsWith(" ") || after.startsWith("\t")) {
    console.error(`止行有缩进,切在了条目中间:${JSON.stringify(after)} —— 拒绝`);
    process.exit(1);
  }
}

const body = lines.slice(a - 1, b - 1);
// include_str! 的相对路径要多退一级(子模块住进了同名目录)
const fixed = [];
const moved = body
  .join(eol)
  .replace(/include_str!\("([^"/][^"]*\.rs)"\)/g, (_m, f) => { fixed.push(f); return `include_str!("../${f}")`; });

const dir = path.join(path.dirname(parent), path.basename(parent, ".rs"));
const outFile = path.join(dir, `${name}.rs`);
const rest = [...lines.slice(0, a - 1), `mod ${name};`, ...lines.slice(b - 1)];

console.log(`${parent}  ${a}..${b}(${b - a} 行)→ ${outFile}`);
console.log(`  主文件 ${lines.length} → ${rest.length} 行`);
if (fixed.length) console.log(`  include_str 退一级:${[...new Set(fixed)].join(", ")}`);
if (dry) {
  console.log(`  起行:${JSON.stringify(first)}`);
  console.log(`  止行:${JSON.stringify(lines[b - 1] ?? "(文件末)")}`);
  console.log("  (--dry,未落盘)");
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(outFile, `use super::*;${eol}${eol}${moved}${eol}`);
fs.writeFileSync(parent, rest.join(eol));
console.log("  ✅ 已落盘(可见性交给编译器)");
