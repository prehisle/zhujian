#!/usr/bin/env node
// 把 `<name>.rs` 末尾那个顶层 `#[cfg(test)] mod tests { … }` 抽到 `<name>/tests.rs`,
// 主文件只留一行 `mod tests;`。310 可维护性轮第 ① 笔的搬家工具。
//
// 用法:node scripts/extract-test-module.mjs core/src/sync/supervisor.rs [--dry]
//
// 全程 fail-closed:凡形状与预期不符(测试模块不在文件末尾 / 收尾不是单个 `}` /
// 有非空行缩进不足 4 格)一律拒绝改动并响亮报错 —— 搬家脚本静默搬错比不搬坏得多。
import fs from "node:fs";
import path from "node:path";

const [, , target, ...flags] = process.argv;
const dry = flags.includes("--dry");
if (!target) {
  console.error("用法: node scripts/extract-test-module.mjs <file.rs> [--dry]");
  process.exit(1);
}

const src = fs.readFileSync(target, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);

// ── 1. 定位顶层测试模块(零缩进的 `mod tests {`,其上一行须是 `#[cfg(test)]`)──
const modIdx = lines.findIndex((l) => /^mod tests\s*\{\s*$/.test(l));
if (modIdx < 0) {
  console.error(`${target}: 找不到零缩进的 \`mod tests {\` —— 形状不符,拒绝改动`);
  process.exit(1);
}
if (lines[modIdx - 1]?.trim() !== "#[cfg(test)]") {
  console.error(`${target}: \`mod tests {\` 上一行不是 \`#[cfg(test)]\`(是 ${JSON.stringify(lines[modIdx - 1])})—— 拒绝`);
  process.exit(1);
}
const attrIdx = modIdx - 1;

// ── 2. 收尾必须是文件最后一个非空行、且恰好是零缩进的 `}` ──
let endIdx = lines.length - 1;
while (endIdx > modIdx && lines[endIdx].trim() === "") endIdx--;
if (lines[endIdx] !== "}") {
  console.error(`${target}: 末尾非空行不是零缩进的 \`}\`(是 ${JSON.stringify(lines[endIdx])})—— 测试模块不在文件末尾,拒绝`);
  process.exit(1);
}

// ── 3. 抽出模块体并去掉一级缩进(每个非空行必须有 4 格,否则拒绝)──
const body = lines.slice(modIdx + 1, endIdx);
const dedented = [];
for (const [i, l] of body.entries()) {
  if (l.trim() === "") { dedented.push(""); continue; }
  if (!l.startsWith("    ")) {
    console.error(`${target}: 模块体第 ${modIdx + 2 + i} 行缩进不足 4 格 —— 拒绝\n  ${JSON.stringify(l)}`);
    process.exit(1);
  }
  dedented.push(l.slice(4));
}

// ── 4. include_str! 的相对路径要多退一级(tests.rs 住进了同名子目录)──
let out = dedented.join(eol);
const fixed = [];
out = out.replace(/include_str!\("([^"/][^"]*\.rs)"\)/g, (_m, f) => {
  fixed.push(f);
  return `include_str!("../${f}")`;
});

// ── 5. 落盘 ──
const dir = path.dirname(target);
const stem = path.basename(target, ".rs");
const outDir = path.join(dir, stem);
const outFile = path.join(outDir, "tests.rs");
const head = lines.slice(0, attrIdx).join(eol);
const newSrc = `${head}${eol}#[cfg(test)]${eol}mod tests;${eol}`;

console.log(`${target}`);
console.log(`  测试段 ${modIdx + 1}..${endIdx + 1}(${body.length} 行)→ ${outFile}`);
console.log(`  主文件 ${lines.length} → ${head.split(eol).length + 2} 行`);
if (fixed.length) console.log(`  include_str 退一级:${[...new Set(fixed)].join(", ")}`);
if (dry) { console.log("  (--dry,未落盘)"); process.exit(0); }

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, out.endsWith(eol) ? out : out + eol);
fs.writeFileSync(target, newSrc);
console.log("  ✅ 已落盘");
