#!/usr/bin/env node
// 把结构锚里的「切掉测试段」换成 `production_src(…)`(310 第 ① 笔配套)。
//
//   let prod = &src[..src.find("mod tests {").expect("本文件有测试模块")];
//   → let prod = production_src(src, "transport.rs");
//
// 测试段搬进 `<name>/tests/` 之后主文件里已没有 `mod tests {`,那句 `expect` 必 panic,
// 故这一格非改不可。标签取「同一个变量最近一次 include_str! 读的文件名」;循环那处
// 手头已有 `file` 变量,直接用它。取不到标签就拒绝改写,不猜。
import fs from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法: node scripts/rewrite-prod-src-sites.mjs <tests.rs> …");
  process.exit(1);
}

const SITE = /let (\w+) = &(\w+)\[\.\.\2\.find\("mod tests \{"\)\.expect\("([^"]*)"\)\];/g;

let total = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let n = 0;
  const out = src.replace(SITE, (whole, lhs, rhs, msg, at) => {
    // 循环那处:标签用手头的 `file` 变量
    if (msg === "每个文件都有测试模块") { n++; return `let ${lhs} = production_src(${rhs}, file);`; }
    // 其余:回头找同一变量最近一次 include_str!
    const before = src.slice(0, at);
    const re = new RegExp(`let ${rhs} = include_str!\\("\\.\\./([^"]+)"\\);`, "g");
    let label = null, m;
    while ((m = re.exec(before)) !== null) label = m[1];
    if (!label) {
      console.error(`${f}: 第 ${before.split("\n").length} 行取不到 ${rhs} 的来源文件名 —— 拒绝改写\n  ${whole}`);
      process.exit(1);
    }
    n++;
    return `let ${lhs} = production_src(${rhs}, "${label}");`;
  });
  if (!n) { console.log(`${f}  (无待改点)`); continue; }

  // 补 import(测试模块的 `use super::*` 够不着 crate::sync::production_src)
  let final_ = out;
  if (!/use crate::sync::production_src;/.test(final_)) {
    if (!/^use super::\*;$/m.test(final_)) {
      console.error(`${f}: 找不到 \`use super::*;\` 这一行,不知道把 import 插哪 —— 拒绝`);
      process.exit(1);
    }
    final_ = final_.replace(/^use super::\*;$/m, "use super::*;\nuse crate::sync::production_src;");
  }
  fs.writeFileSync(f, final_);
  total += n;
  console.log(`${f}  改 ${n} 处`);
}
console.log(`\n共 ${total} 处`);
