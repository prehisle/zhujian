#!/usr/bin/env node
// 按 cargo 的报错逐条给子模块里的条目补 `pub(super)`。**只补编译器点名的那些**,不猜。
// 310 第 ② 笔配套。用法:node scripts/fix-submodule-visibility.mjs <crate 目录>
//
// 每轮只改一遍再重编,直到零错或没有可自动处置的错为止;改了什么全部打印出来。
import { execSync } from "node:child_process";
import fs from "node:fs";

const dir = process.argv[2] ?? "core";
const run = () => {
  try {
    return execSync("cargo build --lib --message-format short 2>&1", {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
    });
  } catch (e) { return e.stdout ?? ""; }
};

let round = 0, changedTotal = 0;
for (;;) {
  round++;
  const out = run();
  // 私有方法:src\a\b.rs:123:45: error[E0624]: method `foo` is private
  const wants = new Map(); // file -> Set<name>
  for (const m of out.matchAll(/^(.+?\.rs):\d+:\d+: error\[E0624\]: (?:method|associated function) `(\w+)` is private/gm)) {
    // 报错点是**调用处**;定义在哪不知道,故全子模块里找同名定义
    wants.set("*", (wants.get("*") ?? new Set()).add(m[2]));
  }
  for (const m of out.matchAll(/error\[E0425\]: cannot find (?:function|value) `(\w+)`/g)) {
    wants.set("*", (wants.get("*") ?? new Set()).add(m[1]));
  }
  for (const m of out.matchAll(/error\[E04(?:33|22)\]: cannot find (?:type|struct, variant or union type) `(\w+)`/g)) {
    wants.set("*", (wants.get("*") ?? new Set()).add(m[1]));
  }
  const names = [...(wants.get("*") ?? [])];
  if (!names.length) {
    const errs = (out.match(/^.*error(\[|:)/gm) ?? []).length;
    console.log(errs ? `\n第 ${round} 轮:还有 ${errs} 条错,但没有可自动处置的 —— 交给人:\n` + out.split("\n").filter((l) => l.includes("error")).slice(0, 12).join("\n") : `\n✅ 第 ${round} 轮:编译干净`);
    break;
  }

  const files = fs.readdirSync(`${dir}/src/sync/transport`).filter((f) => f.endsWith(".rs") && f !== "tests.rs");
  let changed = 0;
  for (const f of files) {
    const p = `${dir}/src/sync/transport/${f}`;
    let src = fs.readFileSync(p, "utf8");
    let before = src;
    for (const n of names) {
      // 顶层条目(零缩进)与 impl 里的方法(四空格)各一条规则;已带可见性的不动
      src = src.replace(
        new RegExp(String.raw`^(\s*)((?:async )?(?:unsafe )?(?:fn|struct|enum|const|static|type) ` + n + String.raw`\b)`, "gm"),
        "$1pub(super) $2",
      );
    }
    if (src !== before) { fs.writeFileSync(p, src); changed++; console.log(`  ${f}`); }
  }
  changedTotal += changed;
  console.log(`第 ${round} 轮:补 ${names.length} 个名字 → 改了 ${changed} 个文件  [${names.join(" ")}]`);
  if (!changed) { console.log("没改动却仍有错 —— 停手,交给人"); break; }
  if (round > 8) { console.log("轮数过多,停手"); break; }
}
console.log(`共改 ${changedTotal} 处文件写入`);
